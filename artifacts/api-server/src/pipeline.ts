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

// ─── Language helpers ────────────────────────────────────────────────────────

export const SUPPORTED_LANGS: Record<string, string> = {
  auto: "זיהוי אוטומטי",
  he: "עברית",
  de: "גרמנית",
  en: "אנגלית",
  fr: "צרפתית",
  es: "ספרדית",
  ar: "ערבית",
  ru: "רוסית",
  uk: "אוקראינית",
  it: "איטלקית",
  pt: "פורטוגלית",
  pl: "פולנית",
  nl: "הולנדית",
  tr: "טורקית",
  zh: "סינית",
  ja: "יפנית",
  ko: "קוריאנית",
  ro: "רומנית",
  hu: "הונגרית",
  cs: "צ'כית",
  sv: "שוודית",
};

export const LANG_NAMES_EN: Record<string, string> = {
  auto: "auto-detected",
  he: "Hebrew",
  de: "German",
  en: "English",
  fr: "French",
  es: "Spanish",
  ar: "Arabic",
  ru: "Russian",
  uk: "Ukrainian",
  it: "Italian",
  pt: "Portuguese",
  pl: "Polish",
  nl: "Dutch",
  tr: "Turkish",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  ro: "Romanian",
  hu: "Hungarian",
  cs: "Czech",
  sv: "Swedish",
};

function langName(code: string): string {
  return LANG_NAMES_EN[code] ?? code;
}

// ─── Subtitle formatting ─────────────────────────────────────────────────────

const MAX_LINE_CHARS = 42;
const MAX_LINES = 2;

/**
 * Wraps subtitle text into at most 2 lines of ~42 chars each,
 * splitting at word boundaries.
 */
function formatSubtitleLines(text: string): string {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (lines.length >= MAX_LINES) break;
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= MAX_LINE_CHARS) {
      current = candidate;
    } else {
      if (current) {
        lines.push(current);
        current = word;
      } else {
        lines.push(word.slice(0, MAX_LINE_CHARS));
        current = "";
      }
    }
  }
  if (current && lines.length < MAX_LINES) lines.push(current);

  return lines.join("\n");
}

// ─── OpenAI ──────────────────────────────────────────────────────────────────

function getOpenAI(): OpenAI {
  if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY || !process.env.AI_INTEGRATIONS_OPENAI_BASE_URL) {
    throw new Error("OpenAI AI integration env vars not set");
  }
  return new OpenAI({
    apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
    baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  });
}

// ─── Temp dir ────────────────────────────────────────────────────────────────

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gerhebrewsub-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ─── SRT builder ─────────────────────────────────────────────────────────────

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
    .filter((s) => s.translatedText?.trim())
    .map((s, i) => {
      const formatted = formatSubtitleLines(s.translatedText!);
      return `${i + 1}\n${secondsToSrtTime(s.startTime)} --> ${secondsToSrtTime(s.endTime)}\n${formatted}\n`;
    })
    .join("\n");
}

// ─── Audio helpers ───────────────────────────────────────────────────────────

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

const MAX_VIDEO_DURATION_SEC = 120 * 60;
const MAX_VIDEO_SIZE_BYTES = 500 * 1024 * 1024;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const CHUNK_SECONDS = 600;
const TRANSCRIBE_TIMEOUT_MS = 3 * 60 * 1000;

// ─── Transcription ───────────────────────────────────────────────────────────

interface VerboseTranscription {
  text: string;
  segments?: Array<{ id: number; start: number; end: number; text: string }>;
}

async function transcribeAudioBuffer(
  openai: OpenAI,
  audioPath: string,
  chunkStart: number,
  sourceLang: string,
): Promise<{ segments: WhisperSegment[]; startOffset: number }> {
  const { createReadStream, statSync } = await import("fs");
  const size = statSync(audioPath).size;
  if (size === 0) return { segments: [], startOffset: chunkStart };

  const langParam = sourceLang !== "auto" ? sourceLang : undefined;
  const fileStream = createReadStream(audioPath);

  let raw: VerboseTranscription;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raw = (await (openai.audio.transcriptions.create as unknown as (p: unknown, o: unknown) => Promise<unknown>)(
      {
        file: fileStream,
        model: "gpt-4o-mini-transcribe",
        ...(langParam ? { language: langParam } : {}),
        response_format: "verbose_json",
      },
      { timeout: TRANSCRIBE_TIMEOUT_MS }
    )) as VerboseTranscription;
  } catch {
    const fileStream2 = createReadStream(audioPath);
    const fallback = await openai.audio.transcriptions.create(
      {
        file: fileStream2 as never,
        model: "gpt-4o-mini-transcribe",
        ...(langParam ? { language: langParam } : {}),
        response_format: "json",
      },
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

async function transcribeWithWhisper(audioPath: string, sourceLang: string): Promise<WhisperSegment[]> {
  const openai = getOpenAI();
  const { statSync } = await import("fs");
  const audioSize = statSync(audioPath).size;
  const totalDuration = await getAudioDuration(audioPath);

  const allSegments: WhisperSegment[] = [];

  if (audioSize <= MAX_AUDIO_BYTES) {
    const { segments } = await transcribeAudioBuffer(openai, audioPath, 0, sourceLang);
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
        const { segments } = await transcribeAudioBuffer(openai, chunkPath, startSec, sourceLang);
        allSegments.push(...segments);
      } finally {
        fs.unlink(chunkPath).catch(() => {});
      }
    }
  }

  return allSegments.map((s, i) => ({ ...s, id: i }));
}

// ─── OCR for burned-in subtitles ─────────────────────────────────────────────

interface OcrResult {
  segments: WhisperSegment[];
  hasBurnedInSubs: boolean;
}

/**
 * Fast detection: sample only N evenly-spaced frames to decide if burned-in
 * subtitles exist. Much cheaper than scanning the full video.
 */
async function detectBurnedInSubsFast(
  videoPath: string,
  tmpDir: string,
  maxFrames = 6,
): Promise<boolean> {
  const duration = await getAudioDuration(videoPath);
  if (duration <= 0) return false;

  const framesDir = path.join(tmpDir, "detect_frames");
  await fs.mkdir(framesDir, { recursive: true });

  // Extract evenly-spaced frames (skip first and last 5%)
  const step = duration / (maxFrames + 1);
  const timestamps = Array.from({ length: maxFrames }, (_, i) => step * (i + 1));

  await Promise.all(
    timestamps.map((ts, i) =>
      execFileAsync("ffmpeg", [
        "-y", "-ss", String(ts.toFixed(2)),
        "-i", videoPath,
        "-frames:v", "1",
        "-q:v", "5",
        "-vf", "crop=iw:ih*0.25:0:ih*0.75", // bottom 25% only
        path.join(framesDir, `detect_${String(i).padStart(2, "0")}.jpg`),
      ]).catch(() => null)
    )
  );

  const frameFiles = (await fs.readdir(framesDir)).sort();
  if (frameFiles.length === 0) return false;

  const openai = getOpenAI();

  // Send all frames in one API call
  const imageContents = await Promise.all(
    frameFiles.map(async (f) => {
      const buf = await fs.readFile(path.join(framesDir, f)).catch(() => null);
      if (!buf) return null;
      return {
        type: "image_url" as const,
        image_url: { url: `data:image/jpeg;base64,${buf.toString("base64")}`, detail: "low" as const },
      };
    })
  );
  const validImages = imageContents.filter(Boolean) as Array<{ type: "image_url"; image_url: { url: string; detail: "low" } }>;
  if (validImages.length === 0) return false;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "user",
          content: [
            ...validImages,
            {
              type: "text",
              text:
                "These are cropped bottom-strip frames from a video. " +
                "Do any of them contain burned-in subtitle text or on-screen captions? " +
                "Reply with ONLY 'yes' or 'no'.",
            },
          ],
        },
      ],
      max_tokens: 5,
    });
    const answer = (res.choices[0]?.message?.content ?? "").trim().toLowerCase();
    return answer.startsWith("y");
  } catch {
    return false;
  }
}

async function extractTextViaOcr(videoPath: string, tmpDir: string, targetLang: string): Promise<OcrResult> {
  const framesDir = path.join(tmpDir, "frames");
  await fs.mkdir(framesDir, { recursive: true });
  await execFileAsync("ffmpeg", [
    "-i", videoPath,
    "-vf", "fps=1/5",
    "-q:v", "2",
    path.join(framesDir, "frame_%04d.jpg"),
  ]);

  const frameFiles = (await fs.readdir(framesDir)).sort();
  if (frameFiles.length === 0) return { segments: [], hasBurnedInSubs: false };

  const openai = getOpenAI();
  const segments: WhisperSegment[] = [];
  let burnedSubCount = 0;
  const targetLangName = langName(targetLang);

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
                text:
                  `Look at the bottom portion of this video frame for any burned-in subtitles or on-screen text. ` +
                  `If you find subtitle text, translate it to ${targetLangName} and return ONLY the translated subtitle text. ` +
                  `If there are no subtitles or on-screen text, return an empty string. ` +
                  `Do NOT describe the image. Do NOT add explanations. Only return the translated text or empty string.`,
              },
            ],
          },
        ],
        max_tokens: 200,
      });
      const text = (res.choices[0]?.message?.content ?? "").trim();
      if (text) {
        segments.push({ id: i, start: frameTime, end: frameTime + 5, text });
        burnedSubCount++;
      }
    } catch {
      // skip frame on error
    }
  }

  return {
    segments,
    hasBurnedInSubs: burnedSubCount > frameFiles.length * 0.1,
  };
}

// ─── Translation ─────────────────────────────────────────────────────────────

const TRANSLATE_TIMEOUT_MS = 2 * 60 * 1000;
const TRANSLATE_BATCH = 15;
const TRANSLATE_CONCURRENCY = 4;

function parseTranslationLines(raw: string, expected: number): string[] | null {
  let lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length >= expected) return lines.slice(0, expected).map((l) => l.replace(/^\d+\.\s*/, "").trim());

  lines = raw.split(/\r?\n+/).filter((l) => l.trim());
  if (lines.length >= expected) return lines.slice(0, expected).map((l) => l.replace(/^\d+\.\s*/, "").trim());

  const numbered = raw.match(/\d+\.\s+[^\d]+/g);
  if (numbered && numbered.length >= expected) return numbered.slice(0, expected).map((l) => l.replace(/^\d+\.\s*/, "").trim());

  return null;
}

async function translateBatch(
  openai: OpenAI,
  batch: WhisperSegment[],
  sourceLang: string,
  targetLang: string,
  batchLabel: string,
): Promise<string[]> {
  const numbered = batch.map((s, idx) => `${idx + 1}. ${s.text}`).join("\n");
  const srcName = langName(sourceLang);
  const tgtName = langName(targetLang);
  const systemPrompt =
    `You are a professional subtitle translator. ` +
    `Translate the following ${batch.length} numbered subtitle lines from ${srcName} to ${tgtName}. ` +
    `Return EXACTLY one translated line per input line, in the same order, with the same numbering (1. 2. 3. ...). ` +
    `Each translation must be on its own separate line. Do NOT merge lines or add commentary. ` +
    `Keep translations concise — subtitles must be short and readable.`;

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
            {
              role: "system",
              content: `Translate the following subtitle text to ${langName(targetLang)}. Return only the translation.`,
            },
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

async function translateSegments(
  segments: WhisperSegment[],
  sourceLang: string,
  targetLang: string,
): Promise<string[]> {
  const results: string[] = new Array(segments.length).fill("");
  const openai = getOpenAI();

  const batches: Array<{ batch: WhisperSegment[]; startIdx: number; label: string }> = [];
  for (let i = 0; i < segments.length; i += TRANSLATE_BATCH) {
    batches.push({
      batch: segments.slice(i, i + TRANSLATE_BATCH),
      startIdx: i,
      label: `batch ${Math.floor(i / TRANSLATE_BATCH) + 1}`,
    });
  }

  for (let g = 0; g < batches.length; g += TRANSLATE_CONCURRENCY) {
    const group = batches.slice(g, g + TRANSLATE_CONCURRENCY);
    const groupResults = await Promise.all(
      group.map(({ batch, label }) => translateBatch(openai, batch, sourceLang, targetLang, label))
    );
    for (let j = 0; j < group.length; j++) {
      const { startIdx, batch } = group[j];
      const translations = groupResults[j];
      for (let k = 0; k < batch.length; k++) {
        results[startIdx + k] = translations[k] ?? batch[k].text;
      }
    }
  }
  return results;
}

// ─── Video helpers ───────────────────────────────────────────────────────────

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

async function getYouTubeDurationSec(url: string, cookiesPath?: string): Promise<number> {
  const ytDlpBin = process.env.YT_DLP_PATH ?? "/home/runner/workspace/bin/yt-dlp";
  try {
    const args = ["--no-playlist", "--print", "duration", "--skip-download"];
    if (cookiesPath) args.push("--cookies", cookiesPath);
    args.push(url);
    const { stdout } = await execFileAsync(ytDlpBin, args, { timeout: 30_000 });
    const sec = parseFloat(stdout.trim());
    return isNaN(sec) ? 0 : sec;
  } catch {
    return 0;
  }
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

// ─── Subtitle embedding ───────────────────────────────────────────────────────

/**
 * Embeds subtitles into the video.
 * position: "bottom" (default) or "top"
 * When coverOriginalSubs=true, a black bar is drawn over the bottom 15% of the
 * frame to erase burned-in subtitles before the translated ones are applied.
 */
async function embedSubtitles(
  videoPath: string,
  srtPath: string,
  outputPath: string,
  coverOriginalSubs: boolean,
  position: "bottom" | "top" = "bottom",
): Promise<void> {
  const escapedSrt = srtPath
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");

  const alignment = position === "top" ? 8 : 2;
  const style = [
    "FontName=DejaVu Sans",
    "FontSize=26",
    `Alignment=${alignment}`,
    "MarginV=35",
    "PrimaryColour=&H00FFFFFF",
    "OutlineColour=&H00000000",
    "BackColour=&H80000000",
    "Outline=2",
    "Shadow=1",
    "Bold=0",
  ].join(",");

  const vfParts: string[] = [];
  if (coverOriginalSubs) {
    vfParts.push("drawbox=x=0:y=ih*0.83:w=iw:h=ih*0.17:color=black:t=fill");
  }
  vfParts.push(`subtitles=${escapedSrt}:force_style='${style}'`);

  await execFileAsync("ffmpeg", [
    "-y", "-i", videoPath,
    "-vf", vfParts.join(","),
    "-c:a", "copy",
    "-preset", "fast",
    "-movflags", "+faststart",
    outputPath,
  ]);
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

export async function runPipeline(jobId: string): Promise<void> {
  const job = await getJobById(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  const sourceLang = job.sourceLang ?? "auto";
  const targetLang = job.targetLang ?? "he";

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

        const ytDuration = await getYouTubeDurationSec(job.inputUrl!, cookiesPath);
        if (ytDuration > 0 && ytDuration > MAX_VIDEO_DURATION_SEC) {
          const mins = Math.round(ytDuration / 60);
          throw new Error(`משך הסרטון (${mins} דקות) עולה על המקסימום המותר של 120 דקות.`);
        }

        await downloadYouTube(job.inputUrl!, videoPath, cookiesPath);
      } else {
        if (job.localPath) {
          const { statSync } = await import("fs");
          const stat = statSync(job.localPath);
          if (stat.size > MAX_VIDEO_SIZE_BYTES) {
            throw new Error(`גודל הקובץ (${(stat.size / 1024 / 1024).toFixed(0)} MB) עולה על המקסימום המותר של 500MB.`);
          }
          await fs.copyFile(job.localPath, videoPath);
          fs.unlink(job.localPath).catch(() => {});
        } else if (job.inputKey) {
          const buf = await gcsDownload(job.inputKey);
          if (buf.length > MAX_VIDEO_SIZE_BYTES) {
            throw new Error(`גודל הקובץ עולה על המקסימום המותר של 500MB.`);
          }
          await fs.writeFile(videoPath, buf);
        } else {
          throw new Error("No video source available");
        }
      }

      const videoDuration = await getAudioDuration(videoPath);
      if (videoDuration > 0 && videoDuration > MAX_VIDEO_DURATION_SEC) {
        const mins = Math.round(videoDuration / 60);
        throw new Error(`משך הסרטון (${mins} דקות) עולה על המקסימום המותר של 120 דקות.`);
      }

      // ── Transcribing ────────────────────────────────────────────────────────
      await advance("transcribing");
      let whisperSegments: WhisperSegment[] = [];
      let hasBurnedInSubs = false;

      if (await hasAudioStream(videoPath)) {
        const audioPath = path.join(tmpDir, "audio.mp3");
        await extractAudio(videoPath, audioPath);
        whisperSegments = await transcribeWithWhisper(audioPath, sourceLang);
      }

      // If no audio found, fall back to OCR of burned-in subtitles
      if (whisperSegments.length === 0) {
        const ocrResult = await extractTextViaOcr(videoPath, tmpDir, targetLang);
        whisperSegments = ocrResult.segments;
        hasBurnedInSubs = ocrResult.hasBurnedInSubs;
        // OCR already returns translated text, so we skip the translation step
        if (hasBurnedInSubs && whisperSegments.length > 0) {
          await updateJob(jobId, { hasBurnedInSubs: true });
        }
      } else {
        // Even if audio exists, quickly check for burned-in subs (6 frames, 1 API call)
        // so we know whether to cover them when embedding.
        try {
          hasBurnedInSubs = await detectBurnedInSubsFast(videoPath, tmpDir);
          if (hasBurnedInSubs) await updateJob(jobId, { hasBurnedInSubs: true });
        } catch {
          // non-critical — proceed without covering
        }
      }

      if (whisperSegments.length === 0) {
        throw new Error("לא נמצא תוכן דיבור או כתוביות בסרטון");
      }

      // ── Translating ─────────────────────────────────────────────────────────
      await advance("translating");
      let translations: string[];

      // If OCR already returned translated text, use it directly
      if (hasBurnedInSubs && !(await hasAudioStream(videoPath))) {
        translations = whisperSegments.map((s) => s.text);
      } else {
        translations = await translateSegments(whisperSegments, sourceLang, targetLang);
      }

      const segmentRows: InsertJobSegment[] = whisperSegments.map((s, i) => ({
        jobId,
        segmentIndex: i,
        startTime: s.start,
        endTime: s.end,
        originalText: s.text,
        translatedText: translations[i] ?? null,
      }));
      await insertSegments(segmentRows);

      // ── Embedding ───────────────────────────────────────────────────────────
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

      const subtitlePosition = (job.subtitlePosition === "top" ? "top" : "bottom") as "top" | "bottom";
      const outputVideoPath = path.join(tmpDir, "output.mp4");
      await embedSubtitles(videoPath, srtPath, outputVideoPath, hasBurnedInSubs, subtitlePosition);

      const outputKey = `outputs/${jobId}/${nanoid(8)}.mp4`;
      const srtKey = `outputs/${jobId}/subtitles.srt`;

      const [outputBuffer] = await Promise.all([
        fs.readFile(outputVideoPath),
        gcsUpload(srtKey, Buffer.from(srtContent, "utf8"), "text/plain"),
      ]);
      await gcsUpload(outputKey, outputBuffer, "video/mp4");

      await updateJob(jobId, { status: "completed", outputKey, srtKey });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await updateJob(jobId, { status: "failed", errorMessage: message, failedAtStatus: currentStatus }).catch(() => {});
    }
  });
}

// ─── Job creators ─────────────────────────────────────────────────────────────

export async function createFileJob(
  fileKey: string,
  originalFilename: string,
  userId?: number,
  localPath?: string,
  sourceLang = "auto",
  targetLang = "he",
  subtitlePosition = "bottom",
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
    sourceLang,
    targetLang,
    subtitlePosition,
  });
  setImmediate(() => runPipeline(id).catch((err: unknown) => logger.error({ err, jobId: id }, "pipeline error")));
  return id;
}

export async function createYouTubeJob(
  url: string,
  cookiesKey: string | undefined,
  userId?: number,
  sourceLang = "auto",
  targetLang = "he",
  subtitlePosition = "bottom",
): Promise<string> {
  const id = nanoid();
  await createJob({
    id,
    userId: userId ?? null,
    status: "pending",
    inputType: "youtube",
    inputUrl: url,
    inputKey: cookiesKey ?? null,
    sourceLang,
    targetLang,
    subtitlePosition,
  });
  setImmediate(() => runPipeline(id).catch((err: unknown) => logger.error({ err, jobId: id }, "pipeline error")));
  return id;
}
