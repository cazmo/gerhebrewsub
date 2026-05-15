/**
 * pipeline.ts
 * Full processing pipeline:
 *   source video → FFmpeg (extract embedded subs OR audio) → Whisper (German)
 *   → LLM translate (Hebrew, batches of 20)
 *   → FFmpeg (burn Hebrew subtitles at bottom, replacing any existing German subs)
 *   → S3 output MP4
 *
 * Strategy for subtitles:
 *  1. Try to extract embedded subtitle tracks from the video (mkv/mp4 with subs).
 *  2. If found → translate those segments to Hebrew.
 *  3. If NOT found → transcribe audio with Whisper (German) → translate to Hebrew.
 *  4. Burn Hebrew SRT into output video using FFmpeg subtitles filter.
 *     - For videos with burned-in (hard-coded) German subtitles: we cannot remove them
 *       without AI inpainting, but we overlay Hebrew subtitles at the very bottom so
 *       they appear below the original text (or replace them if the original is at bottom).
 *     - Alignment=2 (bottom-center), MarginV=20 keeps them at standard subtitle position.
 */

import { execFile } from "child_process";
import { createWriteStream, promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import { nanoid } from "nanoid";
import { createJob, getJobById, insertSegments, updateJob } from "./db";
import { storagePut, storageGetSignedUrl, storageDownload } from "./storage";
import { invokeLLM } from "./_core/llm";
import { ENV } from "./_core/env";
import type { InsertJobSegment } from "../drizzle/schema";

const execFileAsync = promisify(execFile);

// ── helpers ───────────────────────────────────────────────────────────────────

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gerhebrewsub-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function secondsToSrtTime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function buildSrt(segments: Array<{ startTime: number; endTime: number; translatedText: string | null }>): string {
  return segments
    .filter((s) => s.translatedText)
    .map((s, i) => `${i + 1}\n${secondsToSrtTime(s.startTime)} --> ${secondsToSrtTime(s.endTime)}\n${s.translatedText}\n`)
    .join("\n");
}

// ── SRT parser ────────────────────────────────────────────────────────────────

interface SrtSegment {
  id: number;
  start: number;
  end: number;
  text: string;
}

function parseSrtTime(t: string): number {
  // "HH:MM:SS,mmm" or "HH:MM:SS.mmm"
  const [hms, ms] = t.replace(",", ".").split(".");
  const parts = (hms ?? "").split(":").map(Number);
  const h = parts[0] ?? 0;
  const m = parts[1] ?? 0;
  const sec = parts[2] ?? 0;
  return h * 3600 + m * 60 + sec + (Number(ms ?? 0) / 1000);
}

function parseSrt(content: string): SrtSegment[] {
  const blocks = content.trim().split(/\n\s*\n/);
  const segments: SrtSegment[] = [];
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 3) continue;
    const idLine = lines[0]?.trim() ?? "";
    const timeLine = lines[1]?.trim() ?? "";
    const textLines = lines.slice(2).join(" ").trim();
    const timeMatch = timeLine.match(/(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,\.]\d{3})/);
    if (!timeMatch) continue;
    segments.push({
      id: Number(idLine) || segments.length + 1,
      start: parseSrtTime(timeMatch[1] ?? "0"),
      end: parseSrtTime(timeMatch[2] ?? "0"),
      text: textLines,
    });
  }
  return segments;
}

// ── Extract embedded subtitle tracks from video ───────────────────────────────

async function extractEmbeddedSubtitles(videoPath: string, tmpDir: string): Promise<SrtSegment[] | null> {
  try {
    // Probe for subtitle streams
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_streams",
      videoPath,
    ]);

    const probe = JSON.parse(stdout) as { streams?: Array<{ codec_type: string; codec_name: string; index: number; tags?: { language?: string } }> };
    const subStreams = (probe.streams ?? []).filter(
      (s) => s.codec_type === "subtitle"
    );

    if (subStreams.length === 0) return null;

    // Prefer German subtitle track, fallback to first
    const germanStream = subStreams.find((s) =>
      s.tags?.language === "ger" || s.tags?.language === "deu" || s.tags?.language === "de"
    ) ?? subStreams[0];

    if (!germanStream) return null;

    const srtPath = path.join(tmpDir, "embedded.srt");
    await execFileAsync("ffmpeg", [
      "-y",
      "-i", videoPath,
      "-map", `0:${germanStream.index}`,
      srtPath,
    ]);

    const content = await fs.readFile(srtPath, "utf8");
    const segments = parseSrt(content);
    if (segments.length === 0) return null;

    console.log(`[Pipeline] Extracted ${segments.length} embedded subtitle segments`);
    return segments;
  } catch (err) {
    console.log("[Pipeline] No embedded subtitles found:", (err as Error).message);
    return null;
  }
}

// ── Whisper transcription ─────────────────────────────────────────────────────

interface WhisperSegment {
  id: number;
  start: number;
  end: number;
  text: string;
}

async function transcribeWithWhisper(audioBuffer: Buffer, filename: string): Promise<WhisperSegment[]> {
  const formData = new FormData();
  const uint8 = new Uint8Array(audioBuffer);
  const blob = new Blob([uint8], { type: "audio/mpeg" });
  formData.append("file", blob, filename);
  formData.append("model", "whisper-1");
  formData.append("language", "de");
  formData.append("response_format", "verbose_json");

  const apiUrl = ENV.builtInForgeApiUrl;
  const apiKey = ENV.builtInForgeApiKey;

  const res = await fetch(`${apiUrl}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Whisper API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { segments?: WhisperSegment[] };
  return data.segments ?? [];
}

// ── OCR fallback via LLM vision ───────────────────────────────────────────────

async function extractTextViaOcr(videoPath: string, tmpDir: string): Promise<WhisperSegment[]> {
  const framesDir = path.join(tmpDir, "frames");
  await fs.mkdir(framesDir);
  await execFileAsync("ffmpeg", [
    "-i", videoPath,
    "-vf", "fps=1/5",
    "-q:v", "2",
    path.join(framesDir, "frame_%04d.jpg"),
  ]);

  const frameFiles = (await fs.readdir(framesDir)).sort();
  if (frameFiles.length === 0) return [];

  const segments: WhisperSegment[] = [];
  for (let i = 0; i < frameFiles.length; i++) {
    const framePath = path.join(framesDir, frameFiles[i]);
    const frameBuffer = await fs.readFile(framePath);
    const { url } = await storagePut(`frames/${nanoid()}.jpg`, frameBuffer, "image/jpeg");
    const frameTime = i * 5;

    try {
      const response = await invokeLLM({
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url, detail: "low" } },
              {
                type: "text",
                text: "Extract any German spoken text or subtitles visible in this video frame. Return only the text, nothing else. If no text, return empty string.",
              },
            ],
          },
        ],
      });

      const text = (response.choices?.[0]?.message?.content as string ?? "").trim();
      if (text) {
        segments.push({ id: i, start: frameTime, end: frameTime + 5, text });
      }
    } catch {
      // skip frame on error
    }
  }
  return segments;
}

// ── LLM translation to Hebrew ─────────────────────────────────────────────────

async function translateToHebrew(segments: Array<{ text: string }>): Promise<string[]> {
  const BATCH = 20;
  const results: string[] = new Array(segments.length).fill("");

  for (let i = 0; i < segments.length; i += BATCH) {
    const batch = segments.slice(i, i + BATCH);
    const numbered = batch.map((s, idx) => `${idx + 1}. ${s.text}`).join("\n");

    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content:
            "You are a professional German-to-Hebrew subtitle translator. Translate each numbered line from German to Hebrew. Keep the same numbering. Return ONLY the numbered translations, one per line. Preserve the original line count exactly. Keep translations concise for subtitles.",
        },
        { role: "user", content: numbered },
      ],
    });

    const raw = (response.choices?.[0]?.message?.content as string ?? "").trim();
    const lines = raw.split("\n").filter((l) => l.trim());

    for (let j = 0; j < batch.length; j++) {
      const line = lines[j] ?? "";
      results[i + j] = line.replace(/^\d+\.\s*/, "").trim();
    }
  }

  return results;
}

// ── FFmpeg helpers ────────────────────────────────────────────────────────────

async function extractAudio(inputPath: string, outputMp3: string): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-y",
    "-i", inputPath,
    "-vn",
    "-acodec", "libmp3lame",
    "-q:a", "4",
    outputMp3,
  ]);
}

async function downloadYouTube(url: string, outputPath: string, cookiesPath?: string): Promise<void> {
  const args = [
    "--no-playlist",
    "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
    "--merge-output-format", "mp4",
    "-o", outputPath,
  ];
  if (cookiesPath) {
    args.push("--cookies", cookiesPath);
  }
  args.push(url);
  await execFileAsync("yt-dlp", args, { timeout: 300_000 });
}

/**
 * Embed Hebrew SRT subtitles into video.
 * - Alignment=2: bottom-center (standard subtitle position)
 * - MarginV=20: 20px from bottom
 * - FontName=Arial: widely available, supports Hebrew
 * - Encoding=1: Windows-1255 for Hebrew (FFmpeg subtitles filter)
 * - BorderStyle=3: opaque box background for readability
 * - PrimaryColour=&H00FFFFFF: white text
 * - OutlineColour=&H00000000: black outline
 *
 * Note: For videos with hard-coded (burned-in) German subtitles, we cannot
 * remove them without AI inpainting. We place Hebrew subtitles at the very
 * bottom (MarginV=20) which is the standard subtitle area.
 */
async function embedSubtitles(videoPath: string, srtPath: string, outputPath: string): Promise<void> {
  // Escape the srt path for FFmpeg filter (colons and backslashes need escaping)
  const escapedSrt = srtPath.replace(/\\/g, "\\\\").replace(/:/g, "\\:");

  await execFileAsync("ffmpeg", [
    "-y",
    "-i", videoPath,
    "-vf",
    `subtitles='${escapedSrt}':force_style='FontName=Arial,FontSize=22,Alignment=2,MarginV=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H80000000,BorderStyle=3,Outline=1,Shadow=0,Bold=0'`,
    "-c:a", "copy",
    outputPath,
  ]);
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

export async function runPipeline(jobId: string): Promise<void> {
  const job = await getJobById(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  await withTempDir(async (tmpDir) => {
    try {
      // 1. Download/retrieve source video
      await updateJob(jobId, { status: "uploading" });

      const videoPath = path.join(tmpDir, "source.mp4");

      if (job.inputType === "youtube") {
        const url = job.inputUrl!;
        let cookiesPath: string | undefined;

        if (job.inputKey) {
          try {
            const signedUrl = await storageGetSignedUrl(job.inputKey);
            const cookiesRes = await fetch(signedUrl);
            if (cookiesRes.ok) {
              cookiesPath = path.join(tmpDir, "cookies.txt");
              await fs.writeFile(cookiesPath, await cookiesRes.text());
            }
          } catch {
            // proceed without cookies
          }
        }

        await downloadYouTube(url, videoPath, cookiesPath);
      } else {
        // file upload — prefer localPath (disk) over S3 re-download to avoid CloudFront IP blocks
        if (job.localPath) {
          console.log(`[Pipeline] Using localPath: ${job.localPath}`);
          await fs.copyFile(job.localPath, videoPath);
          fs.unlink(job.localPath).catch(() => {});
        } else {
          console.log(`[Pipeline] Downloading from S3 key: ${job.inputKey}`);
          const buf = await storageDownload(job.inputKey!);
          await fs.writeFile(videoPath, buf);
        }
      }

      // 2. Try to extract embedded subtitle tracks first
      await updateJob(jobId, { status: "transcribing" });
      let sourceSegments: Array<{ id: number; start: number; end: number; text: string }> | null = null;

      const embeddedSubs = await extractEmbeddedSubtitles(videoPath, tmpDir);
      if (embeddedSubs && embeddedSubs.length > 0) {
        console.log(`[Pipeline] Using ${embeddedSubs.length} embedded subtitle segments`);
        sourceSegments = embeddedSubs;
      }

      // 3. Fallback: Whisper audio transcription
      if (!sourceSegments || sourceSegments.length === 0) {
        console.log("[Pipeline] No embedded subs, running Whisper transcription...");
        const audioPath = path.join(tmpDir, "audio.mp3");
        await extractAudio(videoPath, audioPath);
        const audioBuffer = await fs.readFile(audioPath);
        const whisperSegs = await transcribeWithWhisper(audioBuffer, "audio.mp3");

        if (whisperSegs.length > 0) {
          sourceSegments = whisperSegs;
        } else {
          // OCR fallback
          console.log("[Pipeline] Whisper returned empty, trying OCR fallback...");
          const ocrSegs = await extractTextViaOcr(videoPath, tmpDir);
          if (ocrSegs.length > 0) {
            sourceSegments = ocrSegs;
          }
        }
      }

      if (!sourceSegments || sourceSegments.length === 0) {
        throw new Error("לא נמצא תוכן דיבור או כתוביות בסרטון");
      }

      // 4. Translate to Hebrew
      await updateJob(jobId, { status: "translating" });
      const translations = await translateToHebrew(sourceSegments);

      // 5. Persist segments
      const segmentRows: InsertJobSegment[] = sourceSegments.map((s, i) => ({
        jobId,
        segmentIndex: i,
        startTime: s.start,
        endTime: s.end,
        originalText: s.text,
        translatedText: translations[i] ?? null,
      }));
      await insertSegments(segmentRows);

      // 6. Build Hebrew SRT
      await updateJob(jobId, { status: "embedding" });
      const srtContent = buildSrt(
        segmentRows.map((s) => ({
          startTime: s.startTime,
          endTime: s.endTime,
          translatedText: s.translatedText ?? null,
        }))
      );
      const srtPath = path.join(tmpDir, "subtitles_he.srt");
      await fs.writeFile(srtPath, "\uFEFF" + srtContent, "utf8"); // BOM for Hebrew UTF-8

      // 7. Embed Hebrew subtitles into video
      const outputVideoPath = path.join(tmpDir, "output.mp4");
      await embedSubtitles(videoPath, srtPath, outputVideoPath);

      // 8. Upload output to S3
      const outputBuffer = await fs.readFile(outputVideoPath);
      const outputKeyBase = `outputs/${jobId}/video-hebrew_${nanoid(8)}.mp4`;
      const { key: outputKey, url: outputUrl } = await storagePut(outputKeyBase, outputBuffer, "video/mp4");

      await updateJob(jobId, {
        status: "completed",
        outputKey,
        outputUrl,
      });

      console.log(`[Pipeline] Job ${jobId} completed. Output key: ${outputKey}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Pipeline] Job ${jobId} failed:`, message);
      await updateJob(jobId, { status: "failed", errorMessage: message }).catch(() => {});
    }
  });
}

// ── Job creation helpers ──────────────────────────────────────────────────────

export async function createFileJob(
  fileKey: string,
  originalFilename: string,
  userId?: number,
  localPath?: string
): Promise<string> {
  const id = nanoid();
  await createJob({
    id,
    userId: userId ?? null,
    status: "pending",
    inputType: "file",
    inputKey: fileKey,
    localPath: localPath ?? null,
    originalFilename,
  });
  // Run pipeline in background (non-blocking)
  setImmediate(() => runPipeline(id).catch(console.error));
  return id;
}

export async function createYouTubeJob(
  url: string,
  cookiesKey: string | undefined,
  userId?: number
): Promise<string> {
  const id = nanoid();
  await createJob({
    id,
    userId: userId ?? null,
    status: "pending",
    inputType: "youtube",
    inputUrl: url,
    inputKey: cookiesKey ?? null,
  });
  setImmediate(() => runPipeline(id).catch(console.error));
  return id;
}
