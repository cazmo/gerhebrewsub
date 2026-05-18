import { execFile } from "child_process";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import { nanoid } from "nanoid";
import OpenAI from "openai";
import { createJob, getJobById, insertSegments, updateJob } from "./db.js";
import { gcsDownload, gcsUpload, gcsBucket, loadGlobalCookies } from "./gcsHelper.js";
import { logger } from "./lib/logger.js";
import type { InsertJobSegment } from "@workspace/db";

const execFileAsync = promisify(execFile);

function getOpenAI(): OpenAI {
  if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY || !process.env.AI_INTEGRATIONS_OPENAI_BASE_URL) {
    throw new Error("OpenAI AI integration env vars not set");
  }
  return new OpenAI({
    apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
    baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  });
}

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

function buildSrt(
  segments: Array<{ startTime: number; endTime: number; translatedText: string | null }>
): string {
  return segments
    .filter((s) => s.translatedText)
    .map((s, i) => `${i + 1}\n${secondsToSrtTime(s.startTime)} --> ${secondsToSrtTime(s.endTime)}\n${s.translatedText}\n`)
    .join("\n");
}

interface WhisperSegment {
  id: number;
  start: number;
  end: number;
  text: string;
}

async function getAudioDuration(audioPath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "quiet", "-print_format", "json", "-show_format", audioPath,
    ]);
    const info = JSON.parse(stdout) as { format?: { duration?: string } };
    return parseFloat(info.format?.duration ?? "0") || 0;
  } catch {
    return 0;
  }
}

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const CHUNK_SECONDS = 600;
const TRANSCRIBE_TIMEOUT_MS = 3 * 60 * 1000;

interface VerboseTranscription {
  text: string;
  segments?: Array<{ id: number; start: number; end: number; text: string }>;
}

async function transcribeAudioBuffer(
  openai: OpenAI,
  audioPath: string,
  chunkStart: number
): Promise<{ segments: WhisperSegment[]; startOffset: number }> {
  const { createReadStream, statSync } = await import("fs");
  const size = statSync(audioPath).size;
  if (size === 0) return { segments: [], startOffset: chunkStart };

  const fileStream = createReadStream(audioPath);

  let raw: VerboseTranscription;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raw = (await (openai.audio.transcriptions.create as unknown as (p: unknown, o: unknown) => Promise<unknown>)(
      { file: fileStream, model: "gpt-4o-mini-transcribe", language: "de", response_format: "verbose_json" },
      { timeout: TRANSCRIBE_TIMEOUT_MS }
    )) as VerboseTranscription;
  } catch {
    const fileStream2 = createReadStream(audioPath);
    const fallback = await openai.audio.transcriptions.create(
      { file: fileStream2 as never, model: "gpt-4o-mini-transcribe", language: "de", response_format: "json" },
      { timeout: TRANSCRIBE_TIMEOUT_MS }
    );
    return { segments: [{ id: 0, start: chunkStart, end: chunkStart + 1, text: fallback.text?.trim() ?? "" }], startOffset: chunkStart };
  }

  if (raw.segments && raw.segments.length > 0) {
    return {
      segments: raw.segments.map((s, i) => ({
        id: i,
        start: chunkStart + s.start,
        end: chunkStart + s.end,
        text: s.text.trim(),
      })),
      startOffset: chunkStart,
    };
  }

  return {
    segments: raw.text?.trim()
      ? [{ id: 0, start: chunkStart, end: chunkStart + 1, text: raw.text.trim() }]
      : [],
    startOffset: chunkStart,
  };
}

async function transcribeWithWhisper(audioPath: string): Promise<WhisperSegment[]> {
  const openai = getOpenAI();
  const { statSync } = await import("fs");
  const audioSize = statSync(audioPath).size;
  const totalDuration = await getAudioDuration(audioPath);

  const allSegments: WhisperSegment[] = [];

  if (audioSize <= MAX_AUDIO_BYTES) {
    const { segments } = await transcribeAudioBuffer(openai, audioPath, 0);
    allSegments.push(...segments);
  } else {
    const numChunks = Math.ceil(totalDuration / CHUNK_SECONDS);

    for (let i = 0; i < numChunks; i++) {
      const startSec = i * CHUNK_SECONDS;
      const chunkDuration = Math.min(CHUNK_SECONDS, totalDuration - startSec);
      const chunkPath = `${audioPath}.chunk${i}.mp3`;

      try {
        await execFileAsync("ffmpeg", [
          "-y", "-i", audioPath,
          "-ss", String(startSec),
          "-t", String(chunkDuration),
          "-acodec", "copy",
          chunkPath,
        ]);
        const { segments } = await transcribeAudioBuffer(openai, chunkPath, startSec);
        allSegments.push(...segments);
      } finally {
        fs.unlink(chunkPath).catch(() => {});
      }
    }
  }

  return allSegments.map((s, i) => ({ ...s, id: i }));
}

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

  const openai = getOpenAI();
  const segments: WhisperSegment[] = [];

  for (let i = 0; i < frameFiles.length; i++) {
    const framePath = path.join(framesDir, frameFiles[i]);
    const frameBuffer = await fs.readFile(framePath);
    const b64 = frameBuffer.toString("base64");
    const dataUrl = `data:image/jpeg;base64,${b64}`;
    const frameTime = i * 5;

    try {
      const res = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
              {
                type: "text",
                text: "Extract any German spoken text or subtitles visible in this video frame. Return only the text, nothing else. If no text, return empty string.",
              },
            ],
          },
        ],
        max_tokens: 200,
      });
      const text = (res.choices[0]?.message?.content ?? "").trim();
      if (text) segments.push({ id: i, start: frameTime, end: frameTime + 5, text });
    } catch {
      // skip frame on error
    }
  }
  return segments;
}

const TRANSLATE_TIMEOUT_MS = 2 * 60 * 1000;
const TRANSLATE_BATCH = 15;

function parseTranslationLines(raw: string, expected: number): string[] | null {
  let lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length >= expected) return lines.slice(0, expected).map((l) => l.replace(/^\d+\.\s*/, "").trim());

  lines = raw.split(/\r?\n+/).filter((l) => l.trim());
  if (lines.length >= expected) return lines.slice(0, expected).map((l) => l.replace(/^\d+\.\s*/, "").trim());

  const numbered = raw.match(/\d+\.\s+[^\d]+/g);
  if (numbered && numbered.length >= expected) return numbered.slice(0, expected).map((l) => l.replace(/^\d+\.\s*/, "").trim());

  return null;
}

async function translateBatch(openai: OpenAI, batch: WhisperSegment[], batchLabel: string): Promise<string[]> {
  const numbered = batch.map((s, idx) => `${idx + 1}. ${s.text}`).join("\n");
  const systemPrompt =
    "You are a professional German-to-Hebrew translator. " +
    `Translate the following ${batch.length} numbered lines from German to Hebrew. ` +
    "Return EXACTLY one translated line per input line, in the same order, with the same numbering (1. 2. 3. ...). " +
    "Each translation must be on its own separate line. Do NOT merge lines or add commentary.";

  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await openai.chat.completions.create(
      {
        model: "gpt-4.1-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: numbered },
        ],
        max_tokens: batch.length * 80,
        temperature: 0.1,
      },
      { timeout: TRANSLATE_TIMEOUT_MS }
    );

    const raw = (response.choices[0]?.message?.content ?? "").trim();
    const parsed = parseTranslationLines(raw, batch.length);
    if (parsed) return parsed;

    if (attempt === 3) break;
  }

  logger.warn({ batchLabel }, "translateBatch: falling back to per-segment translation");
  const individual: string[] = [];
  for (const seg of batch) {
    try {
      const res = await openai.chat.completions.create(
        {
          model: "gpt-4.1-mini",
          messages: [
            { role: "system", content: "Translate the following German text to Hebrew. Return only the translation." },
            { role: "user", content: seg.text },
          ],
          max_tokens: 200,
          temperature: 0.1,
        },
        { timeout: TRANSLATE_TIMEOUT_MS }
      );
      individual.push((res.choices[0]?.message?.content ?? "").trim());
    } catch {
      individual.push(seg.text);
    }
  }
  return individual;
}

async function translateToHebrew(segments: WhisperSegment[]): Promise<string[]> {
  const results: string[] = new Array(segments.length).fill("");
  const openai = getOpenAI();

  for (let i = 0; i < segments.length; i += TRANSLATE_BATCH) {
    const batch = segments.slice(i, i + TRANSLATE_BATCH);
    const batchLabel = `batch ${Math.floor(i / TRANSLATE_BATCH) + 1}`;
    const translations = await translateBatch(openai, batch, batchLabel);
    for (let j = 0; j < batch.length; j++) {
      results[i + j] = translations[j] ?? batch[j].text;
    }
  }
  return results;
}

async function hasAudioStream(videoPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "quiet", "-print_format", "json", "-show_streams",
      "-select_streams", "a", videoPath,
    ]);
    const parsed = JSON.parse(stdout) as { streams?: unknown[] };
    return Array.isArray(parsed.streams) && parsed.streams.length > 0;
  } catch {
    return false;
  }
}

async function extractAudio(inputPath: string, outputMp3: string): Promise<void> {
  await execFileAsync("ffmpeg", ["-y", "-i", inputPath, "-vn", "-acodec", "libmp3lame", "-q:a", "4", outputMp3]);
}

async function downloadYouTube(url: string, outputPath: string, cookiesPath?: string): Promise<void> {
  const ytDlpBin = process.env.YT_DLP_PATH ?? "/home/runner/workspace/bin/yt-dlp";

  const baseArgs = [
    "--no-playlist",
    "--no-check-formats",
    "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best",
    "--merge-output-format", "mp4",
    "--socket-timeout", "30",
    "--retries", "3",
    "-o", outputPath,
  ];

  if (cookiesPath) baseArgs.push("--cookies", cookiesPath);

  const strategies = [
    ["--extractor-args", "youtube:player_client=tv_embedded"],
    ["--extractor-args", "youtube:player_client=ios"],
    ["--extractor-args", "youtube:player_client=mweb"],
    [],
  ];

  const RETRYABLE = ["Sign in", "bot", "Precondition", "not available", "PO Token", "403"];

  let lastError: Error | null = null;
  for (const extraArgs of strategies) {
    try {
      await execFileAsync(ytDlpBin, [...baseArgs, ...extraArgs, url], { timeout: 300_000 });
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const msg = lastError.message ?? "";
      if (RETRYABLE.some((s) => msg.includes(s))) continue;
      throw lastError;
    }
  }

  const isBotBlock = RETRYABLE.some((s) => lastError?.message?.includes(s));
  if (isBotBlock) {
    throw new Error(
      "YouTube חסמה את הגישה מהשרת. יש להעלות קובץ cookies מהדפדפן שלך. " +
      "ראה הוראות בדף הבית."
    );
  }
  throw lastError ?? new Error("YouTube download failed");
}

async function embedSubtitles(videoPath: string, srtPath: string, outputPath: string): Promise<void> {
  const escapedSrt = srtPath
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");

  const style = [
    "FontName=DejaVu Sans",
    "FontSize=26",
    "Alignment=2",
    "MarginV=35",
    "PrimaryColour=&H00FFFFFF",
    "OutlineColour=&H00000000",
    "BackColour=&H80000000",
    "Outline=2",
    "Shadow=1",
    "Bold=0",
  ].join(",");

  await execFileAsync("ffmpeg", [
    "-y", "-i", videoPath,
    "-vf", `subtitles=${escapedSrt}:force_style='${style}'`,
    "-c:a", "copy",
    "-preset", "fast",
    outputPath,
  ]);
}

export async function runPipeline(jobId: string): Promise<void> {
  const job = await getJobById(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  await withTempDir(async (tmpDir) => {
    let currentStatus: "pending" | "uploading" | "transcribing" | "translating" | "embedding" = "pending";

    async function advance(status: typeof currentStatus): Promise<void> {
      await updateJob(jobId, { status });
      currentStatus = status;
    }

    try {
      await advance("uploading");
      const videoPath = path.join(tmpDir, "source.mp4");

      if (job.inputType === "youtube") {
        let cookiesPath: string | undefined;
        if (job.inputKey) {
          try {
            const cookiesBuf = await gcsDownload(job.inputKey);
            cookiesPath = path.join(tmpDir, "cookies.txt");
            await fs.writeFile(cookiesPath, cookiesBuf);
          } catch {
            // proceed without
          }
        }
        if (!cookiesPath) {
          try {
            const globalBuf = await loadGlobalCookies();
            if (globalBuf) {
              cookiesPath = path.join(tmpDir, "cookies.txt");
              await fs.writeFile(cookiesPath, globalBuf);
            }
          } catch {
            // proceed without
          }
        }
        await downloadYouTube(job.inputUrl!, videoPath, cookiesPath);
      } else {
        if (job.localPath) {
          await fs.copyFile(job.localPath, videoPath);
          fs.unlink(job.localPath).catch(() => {});
        } else if (job.inputKey) {
          const buf = await gcsDownload(job.inputKey);
          await fs.writeFile(videoPath, buf);
        } else {
          throw new Error("No video source available");
        }
      }

      await advance("transcribing");
      let whisperSegments: WhisperSegment[] = [];

      if (await hasAudioStream(videoPath)) {
        const audioPath = path.join(tmpDir, "audio.mp3");
        await extractAudio(videoPath, audioPath);
        whisperSegments = await transcribeWithWhisper(audioPath);
      }

      if (whisperSegments.length === 0) {
        whisperSegments = await extractTextViaOcr(videoPath, tmpDir);
      }

      if (whisperSegments.length === 0) {
        throw new Error("לא נמצא תוכן דיבור בסרטון");
      }

      await advance("translating");
      const translations = await translateToHebrew(whisperSegments);

      const segmentRows: InsertJobSegment[] = whisperSegments.map((s, i) => ({
        jobId,
        segmentIndex: i,
        startTime: s.start,
        endTime: s.end,
        originalText: s.text,
        translatedText: translations[i] ?? null,
      }));
      await insertSegments(segmentRows);

      await advance("embedding");
      const srtContent = buildSrt(
        segmentRows.map((s) => ({
          startTime: s.startTime,
          endTime: s.endTime,
          translatedText: s.translatedText ?? null,
        }))
      );
      const srtPath = path.join(tmpDir, "subtitles.srt");
      await fs.writeFile(srtPath, srtContent, "utf8");

      const outputVideoPath = path.join(tmpDir, "output.mp4");
      await embedSubtitles(videoPath, srtPath, outputVideoPath);

      const outputKey = `outputs/${jobId}/${nanoid(8)}.mp4`;
      const outputBuffer = await fs.readFile(outputVideoPath);
      await gcsUpload(outputKey, outputBuffer, "video/mp4");

      await updateJob(jobId, { status: "completed", outputKey });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await updateJob(jobId, { status: "failed", errorMessage: message, failedAtStatus: currentStatus }).catch(() => {});
    }
  });
}

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
  setImmediate(() => runPipeline(id).catch((err: unknown) => logger.error({ err, jobId: id }, "pipeline error")));
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
  setImmediate(() => runPipeline(id).catch((err: unknown) => logger.error({ err, jobId: id }, "pipeline error")));
  return id;
}
