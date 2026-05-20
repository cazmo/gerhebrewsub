import { execFile } from "child_process";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import { nanoid } from "nanoid";
import OpenAI from "openai";
import { createJob, getJobById, insertSegments, updateJob } from "./db.js";
import { gcsDownload, gcsUpload, gcsBucket, gcsEnsurePublic, loadGlobalCookies } from "./gcsHelper.js";
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

// ─── Voice presets for dubbing ───────────────────────────────────────────────

export const VOICES: Array<{ id: string; name: string; gender: "male" | "female" }> = [
  { id: "onyx",    name: "אורי",  gender: "male"   },
  { id: "echo",    name: "איתן",  gender: "male"   },
  { id: "ash",     name: "אריאל", gender: "male"   },
  { id: "nova",    name: "נועה",  gender: "female" },
  { id: "shimmer", name: "שירה",  gender: "female" },
  { id: "coral",   name: "כרמל",  gender: "female" },
];

const VOICE_IDS = new Set(VOICES.map((v) => v.id));

// ─── Subtitle formatting ─────────────────────────────────────────────────────

const MAX_LINE_CHARS = 42;
const MAX_LINES = 2;

/**
 * Wraps subtitle text into at most 2 lines of ~42 chars each,
 * splitting at word boundaries.
 */
function formatSubtitleLines(text: string, maxLines = MAX_LINES, maxChars = MAX_LINE_CHARS): string {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (lines.length >= maxLines) break;
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) {
        lines.push(current);
        current = word;
      } else {
        lines.push(word.slice(0, maxChars));
        current = "";
      }
    }
  }
  if (current && lines.length < maxLines) lines.push(current);

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
  style?: OcrFrameStyle;
}

interface OcrFrameStyle {
  yCenter: number; // 0..1 (center of WHOLE block)
  xCenter: number; // 0..1
  height: number;  // 0..1 — height of ONE LINE (not the whole block)
  width: number;   // 0..1
  lineCount?: number; // how many visible lines in the source block
  color: string;   // #RRGGBB — text fill
  bgColor?: string;     // #RRGGBB — background box color, if any
  hasBox?: boolean;     // true if text sits on an opaque/translucent box
  outlineColor?: string; // #RRGGBB — outline color (usually black)
  bold?: boolean;
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
const CHUNK_SECONDS = 600; // large-file splitting (kept for reference)
const SUBTITLE_CHUNK_SECONDS = 180; // 3-min chunks — balance between parallelism (33 calls for 99-min video) and proxy concurrency limits (going above ~50 concurrent often gets throttled)
// Persistent local-disk dir where finished output MP4s are kept, served via
// `/api/download/:jobId` and `/api/stream/:jobId`. Skipping the 100-500 MB
// GCS upload saves ~10-30 s per job. Uses /tmp by default but lives outside
// the per-job tmpDir so it survives the pipeline cleanup.
export const LOCAL_OUTPUTS_DIR = process.env.LOCAL_OUTPUTS_DIR ?? "/tmp/gerhebrewsub-outputs";
const MAX_SUBTITLE_LINE_CHARS = 42; // per project spec: 2-line subs ≤42 chars each
const TRANSCRIBE_TIMEOUT_MS = 30 * 60 * 1000;

// ─── SRT parser (for transcription response_format:"srt") ────────────────────

function srtTimeToSeconds(t: string): number {
  // format: HH:MM:SS,mmm
  const [hms, ms] = t.trim().split(",");
  const [h, m, s] = (hms ?? "").split(":").map(Number);
  return (h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0) + (parseInt(ms ?? "0", 10) / 1000);
}

function parseSrt(srt: string, startOffset = 0): WhisperSegment[] {
  const blocks = srt.trim().split(/\n\s*\n/);
  const segments: WhisperSegment[] = [];
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 2) continue;
    // find the timecode line: "HH:MM:SS,mmm --> HH:MM:SS,mmm"
    const timeLine = lines.find((l) => l.includes("-->"));
    if (!timeLine) continue;
    const [startStr, endStr] = timeLine.split("-->").map((s) => s.trim());
    if (!startStr || !endStr) continue;
    const start = srtTimeToSeconds(startStr) + startOffset;
    const end = srtTimeToSeconds(endStr) + startOffset;
    // text is everything after the timecode line (skip the index line if numeric)
    const textLines = lines.filter((l) => l !== timeLine && !/^\d+$/.test(l.trim()));
    const text = textLines.join(" ").trim();
    if (text) segments.push({ id: segments.length, start, end, text });
  }
  return segments;
}

// ─── Transcription ───────────────────────────────────────────────────────────

interface VerboseTranscription {
  text: string;
  segments?: Array<{ id: number; start: number; end: number; text: string }>;
}

/**
 * Transcribe a single audio chunk (≤25MB) using whisper-1 with verbose_json.
 * Returns per-segment timestamps RELATIVE to the chunk's start (0..chunkDur).
 */
async function transcribeChunkSegments(
  openai: OpenAI,
  audioPath: string,
  sourceLang: string,
): Promise<Array<{ start: number; end: number; text: string }>> {
  const { createReadStream, statSync } = await import("fs");
  const size = statSync(audioPath).size;
  if (size === 0) return [];

  const langParam = sourceLang !== "auto" ? sourceLang : undefined;
  const fileStream = createReadStream(audioPath);

  const result = (await openai.audio.transcriptions.create(
    {
      file: fileStream as never,
      model: "whisper-1",
      ...(langParam ? { language: langParam } : {}),
      response_format: "verbose_json",
    },
    { timeout: TRANSCRIBE_TIMEOUT_MS }
  )) as unknown as { segments?: Array<{ start: number; end: number; text: string }> };

  return (result.segments ?? [])
    .map((s) => ({ start: s.start, end: s.end, text: (s.text ?? "").trim() }))
    .filter((s) => s.text.length > 0);
}

/**
 * Split audio into SUBTITLE_CHUNK_SECONDS-long pieces and transcribe each one.
 * Each piece gets exact timestamps from its position → many timed segments.
 */
async function transcribeWithWhisper(audioPath: string, sourceLang: string): Promise<WhisperSegment[]> {
  const openai = getOpenAI();
  const totalDuration = await getAudioDuration(audioPath);

  if (totalDuration <= 0) return [];

  // NOTE: a "single-call" fast path on the full compressed audio was tried
  // and was SLOWER (≈ +130 s vs chunked) — the Replit AI proxy serializes a
  // big-file whisper-1 request, while 33 parallel chunks finish in ≈150 s
  // because the proxy fans them out. Keep the chunked path.
  const numChunks = Math.ceil(totalDuration / SUBTITLE_CHUNK_SECONDS);
  const allSegments: WhisperSegment[] = [];

  // Process chunks in parallel groups of 20 — whisper-1 returns native
  // per-segment timestamps inside each 60-sec chunk, so the chunk count
  // (and number of API calls) is ~10× smaller than the old 6-sec scheme.
  const PARALLEL = 1000;
  for (let g = 0; g < numChunks; g += PARALLEL) {
    const groupEnd = Math.min(g + PARALLEL, numChunks);
    const chunkPaths: string[] = [];

    // Extract all chunks in this group with ffmpeg in parallel
    await Promise.all(
      Array.from({ length: groupEnd - g }, (_, idx) => {
        const i = g + idx;
        const startSec = i * SUBTITLE_CHUNK_SECONDS;
        const chunkDuration = Math.min(SUBTITLE_CHUNK_SECONDS, totalDuration - startSec);
        const chunkPath = `${audioPath}.sub${i}.mp3`;
        chunkPaths.push(chunkPath);
        return execFileAsync("ffmpeg", [
          "-y", "-i", audioPath,
          "-ss", String(startSec),
          "-t", String(chunkDuration),
          "-ac", "1", "-ar", "16000",
          "-acodec", "libmp3lame", "-b:a", "24k",
          chunkPath,
        ]).catch(() => null);
      })
    );

    // Transcribe all chunks in this group in parallel, collecting native
    // per-segment timestamps from whisper-1 verbose_json.
    const results = await Promise.all(
      chunkPaths.map((cp, idx) => {
        const i = g + idx;
        const chunkStart = i * SUBTITLE_CHUNK_SECONDS;
        return transcribeChunkSegments(openai, cp, sourceLang)
          .then((segs) => ({ segs, chunkStart }))
          .catch(() => ({ segs: [] as Array<{ start: number; end: number; text: string }>, chunkStart }));
      })
    );

    await Promise.all(chunkPaths.map((cp) => fs.unlink(cp).catch(() => {})));

    for (const { segs, chunkStart } of results) {
      for (const s of segs) {
        allSegments.push({
          id: allSegments.length,
          start: chunkStart + s.start,
          end: chunkStart + s.end,
          text: s.text,
        });
      }
    }
  }

  return allSegments;
}

/**
 * Split a long string into subtitle-sized pieces, breaking at sentence/clause
 * boundaries when possible. Each piece is ≤ maxChars characters.
 */
function splitTextIntoSubtitlePieces(text: string, maxChars: number): string[] {
  const clean = text.trim().replace(/\s+/g, " ");
  if (clean.length <= maxChars) return [clean];

  const pieces: string[] = [];
  // Break at sentence boundaries first
  const sentences = clean.split(/(?<=[.!?。！？])\s+/);
  let current = "";
  for (const s of sentences) {
    if (s.length > maxChars) {
      // Sentence itself too long → split further by commas or words
      if (current) { pieces.push(current); current = ""; }
      const parts = splitByCommaOrWords(s, maxChars);
      pieces.push(...parts);
      continue;
    }
    if (!current) { current = s; continue; }
    if ((current + " " + s).length <= maxChars) {
      current += " " + s;
    } else {
      pieces.push(current);
      current = s;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

function splitByCommaOrWords(text: string, maxChars: number): string[] {
  const pieces: string[] = [];
  const segs = text.split(/(?<=[,،;:])\s+/);
  let current = "";
  for (const s of segs) {
    if (s.length > maxChars) {
      if (current) { pieces.push(current); current = ""; }
      // Hard word-split, with final fallback hard-slicing oversized tokens
      const words = s.split(" ");
      let buf = "";
      for (const w of words) {
        // If a single word is longer than maxChars, hard-slice it
        if (w.length > maxChars) {
          if (buf) { pieces.push(buf.trim()); buf = ""; }
          for (let i = 0; i < w.length; i += maxChars) {
            pieces.push(w.slice(i, i + maxChars));
          }
          continue;
        }
        if ((buf + " " + w).trim().length > maxChars) {
          if (buf) pieces.push(buf.trim());
          buf = w;
        } else {
          buf = (buf ? buf + " " : "") + w;
        }
      }
      if (buf) pieces.push(buf.trim());
      continue;
    }
    if (!current) { current = s; continue; }
    if ((current + " " + s).length <= maxChars) {
      current += " " + s;
    } else {
      pieces.push(current);
      current = s;
    }
  }
  if (current) pieces.push(current);
  return pieces;
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
  maxFrames = 12,
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
        // Full frame: subtitles may appear anywhere (top, middle, bottom).
        // Downscale to keep API payload small.
        "-vf", "scale=640:-2",
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
                "These are frames from a video. " +
                "Do any of them contain burned-in subtitle text or on-screen caption text " +
                "(text overlay anywhere on the frame — top, middle, or bottom — that looks like " +
                "spoken-content captions, not logos or watermarks)? " +
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

const OCR_INTERVAL_SEC_MIN = 2; // ideal interval for short videos
const OCR_MAX_FRAMES = 50; // hard cap on OCR API calls. Dropped from 200 → 50
                           // (75% fewer vision calls) per user request to cut
                           // token spend ~95%. For a 99-min video this means
                           // a sample every ~2 min — long subtitles (≥15-30s,
                           // typical for documentaries / lectures) still get
                           // caught; rapid-fire dialogue may be undersampled.
                           // Combined with the shorter prompt below and the
                           // wider bridge-gap below, net token use is ~6-8% of
                           // the previous level.
const OCR_PARALLEL = 25; // 25 concurrent vision requests is plenty for 50
                         // frames — 2 batches total. (Was 50, sized for 200.)
function computeOcrInterval(durationSec: number): number {
  if (durationSec <= 0) return OCR_INTERVAL_SEC_MIN;
  return Math.max(OCR_INTERVAL_SEC_MIN, Math.ceil(durationSec / OCR_MAX_FRAMES));
}

function findFirstJsonObject(s: string): string | null {
  // Walks the string and returns the first balanced {...} block.
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) return s.slice(start, i + 1);
      if (depth < 0) { depth = 0; start = -1; }
    }
  }
  return null;
}

function parseOcrJson(raw: string): { text: string; style?: OcrFrameStyle } {
  // Be tolerant: strip code fences, find first balanced {...} JSON object
  const cleaned = raw.replace(/```json|```/gi, "").trim();
  let jsonStr = findFirstJsonObject(cleaned);
  if (!jsonStr) {
    // Fallback: treat the whole raw as plain text translation
    const text = cleaned.replace(/^["']|["']$/g, "").trim();
    if (!text || text.toUpperCase() === "NONE") return { text: "" };
    return { text };
  }
  try {
    const obj = JSON.parse(jsonStr) as Record<string, unknown>;
    const text = String(obj.text ?? "").trim();
    if (!text || text.toUpperCase() === "NONE") return { text: "" };
    const num = (v: unknown, def: number): number => {
      const n = typeof v === "number" ? v : parseFloat(String(v));
      return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : def;
    };
    const hex = (v: unknown, def: string | undefined): string | undefined => {
      if (typeof v !== "string") return def;
      const m = v.trim();
      if (!/^#?[0-9a-f]{6}$/i.test(m)) return def;
      return (m.startsWith("#") ? m : `#${m}`).toUpperCase();
    };
    const color = hex(obj.color, "#FFFFFF")!;
    const bgColor = hex(obj.bgColor, undefined);
    const outlineColor = hex(obj.outlineColor, undefined);
    const hasBox = obj.hasBox === true || obj.hasBox === "true";
    const bold = obj.bold === true || obj.bold === "true";
    const lcRaw = typeof obj.lineCount === "number"
      ? obj.lineCount
      : parseInt(String(obj.lineCount ?? ""), 10);
    const lineCount = Number.isFinite(lcRaw) && lcRaw >= 1 ? Math.min(8, Math.round(lcRaw)) : 1;
    const style: OcrFrameStyle = {
      yCenter: num(obj.yCenter, 0.9),
      xCenter: num(obj.xCenter, 0.5),
      height: num(obj.height, 0.06),
      width: num(obj.width, 0.6),
      lineCount,
      color,
      bgColor,
      hasBox,
      outlineColor,
      bold,
    };
    return { text, style };
  } catch {
    return { text: "" };
  }
}

async function extractTextViaOcr(videoPath: string, tmpDir: string, targetLang: string): Promise<OcrResult> {
  const framesDir = path.join(tmpDir, "frames");
  await fs.mkdir(framesDir, { recursive: true });
  const vidDur = await getAudioDuration(videoPath);
  const ocrInterval = computeOcrInterval(vidDur);
  await execFileAsync("ffmpeg", [
    "-i", videoPath,
    "-vf", `fps=1/${ocrInterval},scale=512:-2`,
    "-q:v", "5",
    path.join(framesDir, "frame_%04d.jpg"),
  ]);

  const frameFiles = (await fs.readdir(framesDir)).sort();
  if (frameFiles.length === 0) return { segments: [], hasBurnedInSubs: false };

  const openai = getOpenAI();
  const targetLangName = langName(targetLang);

  // OCR + translate each frame in parallel (groups of OCR_PARALLEL)
  const perFrame: Array<{ idx: number; text: string; style?: OcrFrameStyle }> =
    new Array(frameFiles.length).fill(null).map((_, i) => ({ idx: i, text: "" }));

  for (let g = 0; g < frameFiles.length; g += OCR_PARALLEL) {
    const groupEnd = Math.min(g + OCR_PARALLEL, frameFiles.length);
    await Promise.all(
      Array.from({ length: groupEnd - g }, (_, off) => {
        const i = g + off;
        return (async () => {
          try {
            const buf = await fs.readFile(path.join(framesDir, frameFiles[i]));
            const dataUrl = `data:image/jpeg;base64,${buf.toString("base64")}`;
            const res = await openai.chat.completions.create({
              // Compact prompt — was ~280 tokens of spec, now ~80 tokens.
              // Keeps the same JSON shape so downstream parsing is unchanged.
              model: "gpt-4.1-mini",
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
                    {
                      type: "text",
                      text:
                        `Read ALL burned-in subtitle/overlay text in this frame (including multi-line ` +
                        `blocks — read every line, do NOT truncate), translate the full text to ${targetLangName}, ` +
                        `and measure its bounding box in pixels. Return STRICT JSON ONLY, no prose:\n` +
                        `{"text":"<full translation, keep newlines as \\n>","yCenter":<0..1>,"xCenter":<0..1>,"height":<0..1>,"width":<0..1>,"lineCount":<int ≥1>,"color":"#RRGGBB","outlineColor":"#RRGGBB","hasBox":<bool>,"bgColor":"#RRGGBB","bold":<bool>}\n` +
                        `Coords normalized 0..1 (x=0 left, y=0 top). yCenter/xCenter = center of the WHOLE text block.\n` +
                        `height = height of ONE LINE only (cap to baseline of a single line, ` +
                        `even when the block has many lines). width = horizontal extent of the longest line.\n` +
                        `lineCount = how many visible lines the block actually has.\n` +
                        `Subs may be top/mid/bottom — measure from pixels, don't assume.\n` +
                        `If no readable subtitle (ignore corner logos), return {"text":"NONE"}.`,
                    },
                  ],
                },
              ],
              max_tokens: 300,
            });
            const raw = (res.choices[0]?.message?.content ?? "").trim();
            const parsed = parseOcrJson(raw);
            if (parsed.text) {
              perFrame[i].text = parsed.text;
              perFrame[i].style = parsed.style;
            }
          } catch {
            // skip frame on error
          }
        })();
      })
    );
  }

  // Bridge transient OCR misses: with only 50 samples on long videos the
  // gaps are wider, so we extend the bridge from 1 empty frame to up to 2 —
  // if 1-2 empty frames sit between two text frames carrying the SAME text,
  // fill them in. Different surrounding texts → leave as gap (a real change).
  for (let k = 1; k < perFrame.length - 1; k++) {
    if (perFrame[k].text) continue;
    const prev = perFrame[k - 1];
    if (!prev.text) continue;
    // Look ahead up to 2 frames for a matching text.
    for (let ahead = 1; ahead <= 2 && k + ahead < perFrame.length; ahead++) {
      const next = perFrame[k + ahead];
      if (!next.text) continue;
      if (next.text === prev.text) {
        for (let fill = 0; fill < ahead; fill++) {
          perFrame[k + fill].text = prev.text;
          perFrame[k + fill].style = prev.style;
        }
      }
      break;
    }
  }

  // Collapse adjacent frames with the same translated text into a single segment.
  // For grouped frames, average the style fields so the rendered position/size
  // is a stable mean across the segment duration.
  const segments: WhisperSegment[] = [];
  let i = 0;
  while (i < perFrame.length) {
    const text = perFrame[i].text;
    if (!text) { i++; continue; }
    let j = i + 1;
    while (j < perFrame.length && perFrame[j].text === text) j++;
    const start = i * ocrInterval;
    const end = j * ocrInterval;
    const styles = perFrame.slice(i, j).map((p) => p.style).filter((s): s is OcrFrameStyle => !!s);
    let avgStyle: OcrFrameStyle | undefined;
    if (styles.length > 0) {
      const numericKeys = ["yCenter", "xCenter", "height", "width"] as const;
      const avg = (k: typeof numericKeys[number]): number =>
        styles.reduce((acc, s) => acc + s[k], 0) / styles.length;
      const boxVotes = styles.filter((s) => s.hasBox).length;
      const boldVotes = styles.filter((s) => s.bold).length;
      const maxLc = styles.reduce((m, s) => Math.max(m, s.lineCount ?? 1), 1);
      avgStyle = {
        yCenter: avg("yCenter"),
        xCenter: avg("xCenter"),
        height: avg("height"),
        width: avg("width"),
        lineCount: maxLc,
        color: styles[0].color,
        outlineColor: styles.find((s) => s.outlineColor)?.outlineColor,
        bgColor: styles.find((s) => s.bgColor)?.bgColor,
        hasBox: boxVotes > styles.length / 2,
        bold: boldVotes > styles.length / 2,
      };
    }
    segments.push({ id: segments.length, start, end, text, style: avgStyle });
    i = j;
  }

  const burnedSubCount = perFrame.filter((p) => p.text).length;
  return {
    segments,
    hasBurnedInSubs: burnedSubCount > perFrame.length * 0.1,
  };
}

// ─── Translation ─────────────────────────────────────────────────────────────

const TRANSLATE_TIMEOUT_MS = 2 * 60 * 1000;
const TRANSLATE_BATCH = 500;
const TRANSLATE_CONCURRENCY = 1000;

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
  const tgtName = langName(targetLang);
  const fromClause =
    sourceLang && sourceLang !== "auto"
      ? `from ${langName(sourceLang)} to ${tgtName}`
      : `to ${tgtName} (auto-detect the source language of each line)`;
  const systemPrompt =
    `You are a professional subtitle translator. ` +
    `Translate the following ${batch.length} numbered subtitle lines ${fromClause}. ` +
    `Return EXACTLY one translated line per input line, in the same order, with the same numbering (1. 2. 3. ...). ` +
    `Each translation must be on its own separate line. Do NOT merge lines or add commentary. ` +
    `Keep each translation to at most 80 characters so it fits on 2 subtitle lines — rephrase concisely if needed.`;

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

async function getVideoDimensions(videoPath: string): Promise<{ w: number; h: number }> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "quiet", "-print_format", "json", "-show_streams",
      "-select_streams", "v:0", videoPath,
    ]);
    const parsed = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }> };
    const s = parsed.streams?.[0];
    return { w: s?.width ?? 1280, h: s?.height ?? 720 };
  } catch {
    return { w: 1280, h: 720 };
  }
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
  // Compress directly to mono 16kHz @ 24kbps mp3 — same format Whisper needs.
  // This makes the master audio.mp3 ~30× smaller (e.g. 91MB → ~3MB for 99 min),
  // which dramatically speeds up the per-chunk ffmpeg subdivision step.
  await execFileAsync("ffmpeg", [
    "-y", "-i", inputPath, "-vn",
    "-ac", "1", "-ar", "16000",
    "-acodec", "libmp3lame", "-b:a", "24k",
    outputMp3,
  ]);
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
    "--concurrent-fragments", "16",
    "-N", "16",
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

function secondsToAssTime(s: number): string {
  if (s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s - h * 3600 - m * 60;
  const secStr = sec.toFixed(2).padStart(5, "0"); // SS.cc
  return `${h}:${String(m).padStart(2, "0")}:${secStr}`;
}

function hexToAssColor(hex: string): string {
  // ASS uses &HBBGGRR& (alpha-less primary). hex = "#RRGGBB"
  const h = hex.replace("#", "");
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  return `&H${b}${g}${r}`.toUpperCase();
}

function escapeAssText(s: string): string {
  // Neutralize ASS override blocks, escape codes, and CR.
  // The caller converts intentional "\n" line breaks to "\\N" AFTER this.
  return s
    .replace(/\\/g, "\u200B")
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .replace(/\r/g, "");
}

interface BurnedSegmentLayout {
  start: number;
  end: number;
  text: string;
  bx: number; by: number; bw: number; bh: number; // pixel delogo bbox
  cx: number; cy: number;                          // center
  fontSize: number;
  lineCount: number;                               // # lines in source block
  primary: string;                                 // ASS PrimaryColour (text fill)
  outline: string;                                 // ASS OutlineColour
  back: string;                                    // ASS BackColour (used when hasBox)
  hasBox: boolean;
  bold: boolean;
  textW: number;                                   // pixel width of original text bbox
  textH: number;                                   // pixel height of original text bbox (per-line)
}

function computeBurnedSegmentLayout(
  segments: Array<{ start: number; end: number; text: string; style?: OcrFrameStyle }>,
  videoW: number,
  videoH: number,
): BurnedSegmentLayout[] {
  const out: BurnedSegmentLayout[] = [];
  for (const seg of segments) {
    const text = (seg.text ?? "").trim();
    if (!text) continue;
    const st: OcrFrameStyle = seg.style ?? {
      yCenter: 0.9, xCenter: 0.5, height: 0.06, width: 0.6, color: "#FFFFFF",
    };
    const lineCount = Math.max(1, Math.min(8, st.lineCount ?? 1));
    // Font size = OCR-detected per-line glyph height × small upscale to
    // compensate for OCR usually under-reporting cap-vs-line-height.
    const detectedFs = Math.round(st.height * videoH * 1.05);
    const fontSize = Math.max(16, Math.min(140, detectedFs || Math.round(videoH * 0.055)));
    const cx = Math.max(0, Math.min(videoW, Math.round(st.xCenter * videoW)));
    const cy = Math.max(0, Math.min(videoH, Math.round(st.yCenter * videoH)));
    const lineH = Math.max(8, Math.round(st.height * videoH));
    const textH = lineH; // single-line height
    const blockH = lineH * lineCount;
    const textW = Math.max(20, Math.round(st.width * videoW));
    // Mask box — must cover the WHOLE multi-line block. Width gets +30%
    // margin (outline + side glow), height = block height × 1.4 to absorb
    // line spacing + descenders + outline.
    const maskW = Math.min(videoW - 4, Math.max(40, Math.round(textW * 1.3)));
    const maskH = Math.min(videoH - 4, Math.max(20, Math.round(blockH * 1.4)));
    const bw = maskW;
    const bh = maskH;
    const bx = Math.max(2, Math.min(videoW - bw - 2, cx - Math.round(bw / 2)));
    const by = Math.max(2, Math.min(videoH - bh - 2, cy - Math.round(bh / 2)));
    out.push({
      start: seg.start, end: seg.end, text,
      bx, by, bw, bh, cx, cy, fontSize, lineCount,
      primary: hexToAssColor(st.color),
      outline: hexToAssColor(st.outlineColor ?? "#000000"),
      back: hexToAssColor(st.bgColor ?? "#000000"),
      hasBox: st.hasBox === true,
      bold: st.bold === true,
      textW, textH,
    });
  }
  return out;
}

/**
 * Builds an ASS subtitle file that places each translated segment at the
 * original burned-in subtitle's position with matching size and color.
 * The original burned text is removed separately via ffmpeg's `delogo`
 * filter so no black cover is needed.
 */
function buildAssFromBurnedSegments(
  layout: BurnedSegmentLayout[],
  videoW: number,
  videoH: number,
  spokenStrip?: Array<{ start: number; end: number; text: string }>,
): string {
  // Bottom-strip style: classic spoken-audio subtitle band, white text on
  // semi-transparent black box, anchored bottom-center. Lives in the SAME
  // ASS file as the in-place burned-in events so a single libass pass
  // renders both — chaining two ffmpeg `subtitles=` filters causes the
  // second one to silently drop on many libass builds.
  const bottomFs = Math.max(20, Math.round(videoH * 0.05));
  const header =
    "[Script Info]\n" +
    "ScriptType: v4.00+\n" +
    "WrapStyle: 2\n" +
    "ScaledBorderAndShadow: yes\n" +
    `PlayResX: ${videoW}\n` +
    `PlayResY: ${videoH}\n` +
    "\n" +
    "[V4+ Styles]\n" +
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" +
    "Style: Default,DejaVu Sans,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,2,1,5,0,0,0,1\n" +
    `Style: Bottom,DejaVu Sans,${bottomFs},&H00FFFFFF,&H000000FF,&H00000000,&HCC000000,0,0,0,0,100,100,0,0,3,4,0,2,40,40,30,1\n` +
    "Style: Cover,DejaVu Sans,10,&H00000000,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1\n" +
    "\n" +
    "[Events]\n" +
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";

  const events: string[] = [];
  for (const seg of layout) {
    const start = secondsToAssTime(seg.start);
    const end = secondsToAssTime(seg.end);
    // Wrap to match the source block: up to `lineCount` lines, with chars
    // per line scaled to the detected width. This preserves the visual
    // footprint of the original German block so the Hebrew rendering
    // occupies the same vertical span at the same font size — instead of
    // shrinking everything to 2 short lines.
    const maxLines = Math.max(2, Math.min(8, seg.lineCount));
    // Estimate chars-per-line from the OCR-measured text width vs font size.
    // At ~0.55em per char for DejaVu Sans, perLine = textW / (fs * 0.55).
    const perLine = Math.max(20, Math.min(80, Math.round(seg.textW / (seg.fontSize * 0.55))));
    const wrapped = formatSubtitleLines(seg.text, maxLines, perLine);
    const safe = escapeAssText(wrapped).replace(/\n/g, "\\N");
    const bold = seg.bold ? 1 : 0;
    // Outline+shadow (BorderStyle=1) — clean text matching the original.
    const textOverride =
      `{\\an5\\pos(${seg.cx},${seg.cy})\\fs${seg.fontSize}` +
      `\\c${seg.primary}\\3c${seg.outline}\\4c&H80000000&` +
      `\\bord2\\shad1\\b${bold}\\bs1}`;
    events.push(
      `Dialogue: 1,${start},${end},Default,,0,0,0,,${textOverride}${safe}`,
    );
  }

  // Spoken-audio bottom strip (independent layer so it draws even when an
  // in-place event covers the same time range).
  if (spokenStrip && spokenStrip.length > 0) {
    for (const seg of spokenStrip) {
      if (!seg.text?.trim()) continue;
      const start = secondsToAssTime(seg.start);
      const end = secondsToAssTime(seg.end);
      const wrapped = formatSubtitleLines(seg.text, 2, 42);
      const safe = escapeAssText(wrapped).replace(/\n/g, "\\N");
      events.push(`Dialogue: 2,${start},${end},Bottom,,0,0,0,,${safe}`);
    }
  }

  // Silence unused-param lint (kept for header sizing)
  void videoW; void videoH;
  return header + events.join("\n") + "\n";
}

/**
 * Embeds subtitles into the video.
 * position: "bottom" (default) or "top"
 * When subPath is .ass (burned-in flow) it already contains per-segment
 * position, style and cover boxes — no drawbox needed.
 */
function escapeFfmpegSubPath(p: string): string {
  return p
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/,/g, "\\,")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

async function embedSubtitles(
  videoPath: string,
  subPath: string,
  outputPath: string,
  coverOriginalSubs: boolean,
  position: "bottom" | "top" = "bottom",
  delogoRegions?: BurnedSegmentLayout[],
  extraBottomSrtPath?: string,
): Promise<void> {
  const isAss = subPath.toLowerCase().endsWith(".ass");

  const escapedPath = escapeFfmpegSubPath(subPath);

  const vfParts: string[] = [];

  // Erase original burned-in subtitles using stacked `delogo` filters —
  // a LINEAR chain (single pass through the video) instead of N split/
  // overlay branches which scale exponentially. Each delogo inpaints the
  // region using surrounding pixel colors, so there's no visible black
  // box. Time-gated via `enable=` so each region only affects its own
  // display window. The translated subtitle is drawn afterwards at the
  // same cx/cy with the same font size, color, outline as detected by OCR.
  if (delogoRegions && delogoRegions.length > 0) {
    // SPEED: merge adjacent regions whose bboxes overlap (typical case:
    // consecutive OCR samples of the same on-screen subtitle position).
    // Each delogo filter has per-frame overhead even when gated by `enable=`,
    // so cutting the chain from 200+ to ~30-60 has a measurable encode-time
    // win on long videos. Two regions merge when they are close in time
    // (≤4 s gap) AND their bboxes have IoU > 0.5 — we expand the bbox to
    // their union and stretch the enable= window to cover both.
    type Merged = { x: number; y: number; w: number; h: number; start: number; end: number };
    const merged: Merged[] = [];
    const sorted = delogoRegions
      .slice()
      .sort((a, b) => a.start - b.start);
    for (const r of sorted) {
      const cur: Merged = {
        x: Math.max(1, r.bx),
        y: Math.max(1, r.by),
        w: Math.max(2, r.bw),
        h: Math.max(2, r.bh),
        start: r.start,
        end: r.end,
      };
      const last = merged[merged.length - 1];
      if (last && cur.start - last.end <= 4) {
        const ix1 = Math.max(last.x, cur.x);
        const iy1 = Math.max(last.y, cur.y);
        const ix2 = Math.min(last.x + last.w, cur.x + cur.w);
        const iy2 = Math.min(last.y + last.h, cur.y + cur.h);
        const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
        const union = last.w * last.h + cur.w * cur.h - inter;
        const iou = union > 0 ? inter / union : 0;
        if (iou > 0.5) {
          const nx = Math.min(last.x, cur.x);
          const ny = Math.min(last.y, cur.y);
          const nx2 = Math.max(last.x + last.w, cur.x + cur.w);
          const ny2 = Math.max(last.y + last.h, cur.y + cur.h);
          last.x = nx;
          last.y = ny;
          last.w = nx2 - nx;
          last.h = ny2 - ny;
          last.end = Math.max(last.end, cur.end);
          continue;
        }
      }
      merged.push(cur);
    }
    for (const r of merged) {
      vfParts.push(
        `delogo=x=${r.x}:y=${r.y}:w=${r.w}:h=${r.h}:enable='between(t,${r.start.toFixed(2)},${r.end.toFixed(2)})'`,
      );
    }
  }

  if (isAss) {
    // ASS already encodes per-line position, color and size.
    vfParts.push(`subtitles=${escapedPath}`);
  } else {
    const alignment = position === "top" ? 8 : 2;
    const style = coverOriginalSubs
      ? [
          "FontName=DejaVu Sans",
          "FontSize=29",
          `Alignment=${alignment}`,
          "MarginV=15",
          "MarginL=40",
          "MarginR=40",
          "PrimaryColour=&H00FFFFFF",
          "OutlineColour=&H00000000",
          "BorderStyle=1",
          "Outline=3",
          "Shadow=1",
          "Bold=1",
          "WrapStyle=2",
        ].join(",")
      : [
          "FontName=DejaVu Sans",
          "FontSize=29",
          `Alignment=${alignment}`,
          "MarginV=20",
          "MarginL=40",
          "MarginR=40",
          "PrimaryColour=&H00FFFFFF",
          "OutlineColour=&H00000000",
          "BackColour=&HCC000000",
          "BorderStyle=3",
          "Outline=4",
          "Shadow=0",
          "Bold=0",
          "WrapStyle=2",
        ].join(",");
    if (coverOriginalSubs) {
      // SRT fallback for burned-in source (rare): erase bottom strip first
      // so the translated subtitle isn't laid over the original.
      vfParts.push("drawbox=x=0:y=ih*0.72:w=iw:h=ih*0.28:color=black:t=fill");
    }
    vfParts.push(`subtitles=${escapedPath}:force_style='${style}'`);
  }

  // Optional extra bottom subtitle band (spoken-audio translation strip).
  if (extraBottomSrtPath) {
    const extraEscaped = escapeFfmpegSubPath(extraBottomSrtPath);
    const extraStyle = [
      "FontName=DejaVu Sans","FontSize=26","Alignment=2","MarginV=20",
      "MarginL=40","MarginR=40","PrimaryColour=&H00FFFFFF",
      "OutlineColour=&H00000000","BackColour=&HCC000000",
      "BorderStyle=3","Outline=4","Shadow=0","Bold=0","WrapStyle=2",
    ].join(",");
    vfParts.push(`subtitles=${extraEscaped}:force_style='${extraStyle}'`);
  }

  const totalDur = await getAudioDuration(videoPath);
  const NUM_SEG = 6; // matches available CPUs; each ffmpeg runs single-threaded
  // veryfast (not ultrafast) + CRF 26 + downscale to 360p: produces ~5× smaller
  // output (~100MB vs ~580MB for a 99-min source) which dramatically cuts the
  // GCS upload time at the end of the embedding stage. Encode speed stays
  // roughly the same because the smaller pixel count offsets the slower
  // preset. We append the scale filter AFTER existing vfParts so subtitles
  // and delogo run on the original-resolution frames (where their pixel
  // coordinates are calibrated) and the scale happens last.
  // Cap output width at 640 to control file size / upload time. Use
  // `trunc(.../2)*2` to guarantee an even width (libx264 + yuv420p requires
  // both dimensions even); `-2` handles the height side.
  const VF_TAIL = ",scale='trunc(min(iw,640)/2)*2':-2";
  const VCODEC_FLAGS = [
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
    "-pix_fmt", "yuv420p",
    "-tune", "fastdecode",
    "-g", "60", "-keyint_min", "60",
    "-movflags", "+faststart",
  ];

  // Short videos: single pass (parallelization overhead not worth it)
  if (totalDur <= 0 || totalDur < 90) {
    await execFileAsync("ffmpeg", [
      "-y", "-threads", "0", "-i", videoPath,
      "-vf", vfParts.join(",") + VF_TAIL,
      "-c:a", "aac", "-b:a", "96k", "-ac", "2",
      ...VCODEC_FLAGS,
      outputPath,
    ]);
    return;
  }

  // Parallel-segment encoding: split into N time slices, run N ffmpeg processes
  // in parallel using `-copyts` so the subtitle/delogo filter expressions keep
  // their original absolute timestamps. `-output_ts_offset` shifts output PTS
  // back to 0 for each segment so concat-demux works.
  const segDur = totalDur / NUM_SEG;
  const segFiles: string[] = new Array(NUM_SEG);
  await Promise.all(
    Array.from({ length: NUM_SEG }, async (_, i) => {
      const start = i * segDur;
      const end = i === NUM_SEG - 1 ? totalDur : start + segDur;
      const segOut = `${outputPath}.seg${i}.mp4`;
      segFiles[i] = segOut;
      await execFileAsync("ffmpeg", [
        "-y",
        "-ss", start.toFixed(3),
        "-copyts",
        "-i", videoPath,
        // With `-copyts` the input PTS is preserved, so `-t D` (which means
        // "stop after D seconds of OUTPUT PTS counted from 0") would terminate
        // immediately for any segment where start > D. Use `-to` (absolute
        // input-PTS stop time) instead. Bug fix: previous `-t` produced empty
        // outputs for segments 2..N.
        "-to", end.toFixed(3),
        "-vf", vfParts.join(",") + VF_TAIL,
        ...VCODEC_FLAGS,
        "-threads", "1",
        "-c:a", "aac", "-b:a", "96k", "-ac", "2",
        "-output_ts_offset", `-${start.toFixed(3)}`,
        "-avoid_negative_ts", "make_zero",
        segOut,
      ]);
    }),
  );

  const listPath = `${outputPath}.concat.txt`;
  await fs.writeFile(
    listPath,
    segFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"),
    "utf8",
  );
  await execFileAsync("ffmpeg", [
    "-y", "-f", "concat", "-safe", "0", "-i", listPath,
    "-c", "copy", "-movflags", "+faststart",
    outputPath,
  ]);
}

// ─── TTS dubbing ─────────────────────────────────────────────────────────────

const TTS_CONCURRENCY = 1000;

/**
 * Synthesizes each translated segment to MP3 via OpenAI TTS, then mixes the
 * clips onto a silent track of the original duration (each clip starts at its
 * segment startTime). If a clip is longer than its segment slot, it is sped up
 * with `atempo` so subsequent segments aren't shifted out of sync.
 *
 * Returns the path to a single dubbed audio track (m4a) of `videoDuration`
 * seconds.
 */
async function generateDubbedAudio(
  segments: Array<{ startTime: number; endTime: number; translatedText: string | null }>,
  videoDuration: number,
  voiceId: string,
  tmpDir: string,
): Promise<string | null> {
  const openai = getOpenAI();
  const ttsDir = path.join(tmpDir, "tts");
  await fs.mkdir(ttsDir, { recursive: true });

  type Clip = { idx: number; start: number; slot: number; path: string };
  const clips: Clip[] = [];

  const usable = segments
    .map((s, i) => ({ ...s, i }))
    .filter((s) => (s.translatedText ?? "").trim().length > 0);

  // Generate TTS in parallel batches
  for (let g = 0; g < usable.length; g += TTS_CONCURRENCY) {
    const groupEnd = Math.min(g + TTS_CONCURRENCY, usable.length);
    const settled = await Promise.allSettled(
      usable.slice(g, groupEnd).map(async (s) => {
        const mp3Path = path.join(ttsDir, `seg_${s.i}.mp3`);
        const res = await openai.audio.speech.create({
          model: "gpt-4o-mini-tts",
          voice: voiceId,
          input: s.translatedText!,
          response_format: "mp3",
        });
        const buf = Buffer.from(await res.arrayBuffer());
        await fs.writeFile(mp3Path, buf);
        const slot = Math.max(0.5, s.endTime - s.startTime);
        clips.push({ idx: s.i, start: s.startTime, slot, path: mp3Path });
      }),
    );
    for (const r of settled) {
      if (r.status === "rejected") {
        logger.warn({ err: r.reason }, "TTS clip failed");
      }
    }
  }

  if (clips.length === 0) {
    return null;
  }

  clips.sort((a, b) => a.start - b.start);

  // Probe each clip's duration so we can fit it to its slot via atempo.
  async function probeDuration(p: string): Promise<number> {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      p,
    ]);
    const d = parseFloat(stdout.trim());
    return Number.isFinite(d) && d > 0 ? d : 0;
  }

  function atempoChain(speed: number): string {
    // atempo supports 0.5..2.0 per stage; chain stages for larger speeds.
    const stages: number[] = [];
    let s = speed;
    while (s > 2.0) { stages.push(2.0); s /= 2.0; }
    while (s < 0.5) { stages.push(0.5); s /= 0.5; }
    stages.push(s);
    return stages.map((v) => `atempo=${v.toFixed(4)}`).join(",");
  }

  const inputs: string[] = [];
  const filterParts: string[] = [];
  // Base silent track (input 0)
  inputs.push("-f", "lavfi", "-i", `anullsrc=channel_layout=stereo:sample_rate=44100`);

  const overlayLabels: string[] = [];
  let inputIndex = 1;
  for (const c of clips) {
    const dur = await probeDuration(c.path);
    inputs.push("-i", c.path);
    const delayMs = Math.max(0, Math.round(c.start * 1000));
    // If clip is longer than its slot, speed it up so it fits (cap speed at 1.6×
    // to keep voice natural; if still too long, allow overflow into next slot).
    const overflow = dur > c.slot * 1.05;
    const filters: string[] = [];
    if (overflow) {
      const speed = Math.min(1.6, dur / Math.max(0.5, c.slot));
      filters.push(atempoChain(speed));
    }
    filters.push(`adelay=${delayMs}|${delayMs}`);
    filters.push(`apad=pad_dur=0.01`);
    filterParts.push(`[${inputIndex}:a]${filters.join(",")}[a${inputIndex}]`);
    overlayLabels.push(`[a${inputIndex}]`);
    inputIndex++;
  }

  // Mix base silence + all delayed TTS clips
  const mixInputs = [`[0:a]`, ...overlayLabels].join("");
  filterParts.push(
    `${mixInputs}amix=inputs=${overlayLabels.length + 1}:duration=first:dropout_transition=0:normalize=0[mixed]`,
  );

  const dubPath = path.join(tmpDir, "dub.m4a");
  await execFileAsync("ffmpeg", [
    "-y",
    ...inputs,
    "-filter_complex", filterParts.join(";"),
    "-map", "[mixed]",
    "-t", videoDuration.toFixed(3),
    "-c:a", "aac", "-b:a", "160k",
    dubPath,
  ]);
  return dubPath;
}

/**
 * Replaces audio in `videoPath` with the dubbed track. Original audio is
 * ducked to 15% under the dub so background music/SFX remain audible.
 */
async function muxDubbedAudio(
  videoPath: string,
  dubPath: string,
  outputPath: string,
  hasOriginalAudio: boolean,
): Promise<void> {
  // Dub fully REPLACES the original audio — original track is dropped so the
  // viewer hears only the selected Hebrew TTS voice. `hasOriginalAudio` is
  // kept in the signature for backward compatibility but no longer affects
  // the mux (it's intentionally unused).
  void hasOriginalAudio;
  await execFileAsync("ffmpeg", [
    "-y",
    "-i", videoPath,
    "-i", dubPath,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", "aac", "-b:a", "192k",
    "-shortest",
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

      const audioExists = await hasAudioStream(videoPath);
      if (audioExists) {
        const audioPath = path.join(tmpDir, "audio.mp3");
        await extractAudio(videoPath, audioPath);
        whisperSegments = await transcribeWithWhisper(audioPath, sourceLang);
      }

      // Check for burned-in subs (cheap detection: 6 frames, 1 API call)
      let burnedInTranslatedAlready = false;
      try {
        if (whisperSegments.length > 0) {
          hasBurnedInSubs = await detectBurnedInSubsFast(videoPath, tmpDir);
        } else {
          hasBurnedInSubs = true;
        }
      } catch {
        hasBurnedInSubs = false;
      }

      const spokenSegments: WhisperSegment[] = whisperSegments.slice();

      if (hasBurnedInSubs) {
        const ocrResult = await extractTextViaOcr(videoPath, tmpDir, targetLang);
        if (ocrResult.segments.length > 0) {
          whisperSegments = ocrResult.segments;
          burnedInTranslatedAlready = true;
          hasBurnedInSubs = ocrResult.hasBurnedInSubs;
          await updateJob(jobId, { hasBurnedInSubs: true });
        } else if (whisperSegments.length === 0) {
          hasBurnedInSubs = false;
        }
      }

      if (whisperSegments.length === 0) {
        throw new Error("לא נמצא תוכן דיבור או כתוביות בסרטון");
      }

      // ── Translating ─────────────────────────────────────────────────────────
      await advance("translating");
      let translations: string[];
      // Translated spoken-audio segments — used for the bottom strip in the
      // burned-in branch and for TTS dubbing.
      let spokenTranslations: string[] = [];

      // If OCR already returned translated text, use it for the in-place layer.
      if (burnedInTranslatedAlready) {
        translations = whisperSegments.map((s) => s.text);
        if (spokenSegments.length > 0) {
          spokenTranslations = await translateSegments(spokenSegments, sourceLang, targetLang);
        }
      } else {
        translations = await translateSegments(whisperSegments, sourceLang, targetLang);
        spokenTranslations = translations;
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

      // Build a separate SRT for SPOKEN-AUDIO translations (the speaker). In
      // the burned-in branch this drives the classic bottom strip and the TTS
      // dub, independently from the on-screen OCR text.
      const spokenSubs = spokenSegments.map((s, i) => ({
        startTime: s.start,
        endTime: s.end,
        translatedText: spokenTranslations[i] ?? null,
      }));
      const spokenSrtPath = path.join(tmpDir, "subtitles.spoken.srt");
      if (spokenSubs.length > 0) {
        await fs.writeFile(spokenSrtPath, buildSrt(spokenSubs), "utf8");
      }

      const subtitlePosition = (job.subtitlePosition === "top" ? "top" : "bottom") as "top" | "bottom";
      const outputVideoPath = path.join(tmpDir, "output.mp4");

      // For burned-in source: build ASS that places each OCR translation at
      // the original subtitle's exact bbox with matching color/size/box, AND
      // overlay a classic bottom strip carrying the SPEAKER's translation.
      if (burnedInTranslatedAlready) {
        const { w: vidW, h: vidH } = await getVideoDimensions(videoPath);
        const layout = computeBurnedSegmentLayout(
          segmentRows.map((s, i) => ({
            start: s.startTime,
            end: s.endTime,
            text: s.translatedText ?? "",
            style: whisperSegments[i]?.style,
          })),
          vidW,
          vidH,
        );
        // Build single ASS file containing BOTH in-place OCR translations
        // AND the spoken-audio bottom strip. Two libass passes (chained
        // `subtitles=` filters) don't reliably composite — the second one
        // gets dropped silently. Merging into one ASS guarantees both
        // layers render.
        const spokenStripForAss = spokenSubs
          .filter((s) => s.translatedText?.trim())
          .map((s) => ({
            start: s.startTime,
            end: s.endTime,
            text: s.translatedText as string,
          }));
        const assContent = buildAssFromBurnedSegments(layout, vidW, vidH, spokenStripForAss);
        const assPath = path.join(tmpDir, "subtitles.ass");
        await fs.writeFile(assPath, assContent, "utf8");
        await embedSubtitles(videoPath, assPath, outputVideoPath, true, subtitlePosition, layout);
        // spokenSrtPath was prepared above for backward-compat / debugging
        // but is no longer required as a separate ffmpeg input.
        void spokenSrtPath;
      } else {
        await embedSubtitles(videoPath, srtPath, outputVideoPath, hasBurnedInSubs, subtitlePosition);
      }

      // ── Dubbing (optional) ──────────────────────────────────────────────────
      const voiceId = normalizeVoiceId(job.voiceId ?? null);
      if (voiceId) {
        try {
          // Dub from spoken-audio translations (the speaker), not OCR text.
          const dubSourceSegments = spokenSubs.length > 0
            ? spokenSubs.map((s) => ({
                startTime: s.startTime,
                endTime: s.endTime,
                translatedText: s.translatedText,
              }))
            : segmentRows.map((s) => ({
                startTime: s.startTime,
                endTime: s.endTime,
                translatedText: s.translatedText ?? null,
              }));
          const dubPath = await generateDubbedAudio(
            dubSourceSegments,
            videoDuration,
            voiceId,
            tmpDir,
          );
          if (!dubPath) {
            logger.info({ jobId }, "no usable TTS clips; keeping original audio");
          } else {
            const dubbedVideoPath = path.join(tmpDir, "output.dubbed.mp4");
            await muxDubbedAudio(outputVideoPath, dubPath, dubbedVideoPath, audioExists);
            await fs.copyFile(dubbedVideoPath, outputVideoPath);
          }
        } catch (dubErr) {
          logger.warn({ err: dubErr, jobId }, "dubbing failed; keeping original audio");
        }
      }

      // SPEED: instead of uploading the 100-500 MB output mp4 to GCS (slow
      // network leg at the end of every job), copy it into a persistent
      // local-disk dir and serve it from there via the `/api/download/:jobId`
      // route. Saves ~10-30 s per job for long videos. SRT is tiny → still
      // goes to GCS so the public link works regardless of server lifetime.
      // Sentinel `local:` outputKey signals to the download/stream routes
      // (resolveOutputSource) that the MP4 was never uploaded to GCS and
      // lives only on local disk. This is honest about durability: if the
      // container restarts / /tmp is cleaned, the download will 404 instead
      // of issuing a GCS metadata request for an object that was never
      // created. The user accepted this trade-off to skip the slow upload.
      const outputKey = `local:${jobId}.mp4`;
      const srtKey = `outputs/${jobId}/subtitles.srt`;
      const localOutputPath = path.join(LOCAL_OUTPUTS_DIR, `${jobId}.mp4`);

      await fs.mkdir(LOCAL_OUTPUTS_DIR, { recursive: true });
      await Promise.all([
        fs.copyFile(outputVideoPath, localOutputPath),
        gcsUpload(srtKey, Buffer.from(srtContent, "utf8"), "text/plain"),
      ]);

      await updateJob(jobId, { status: "completed", outputKey, srtKey });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await updateJob(jobId, { status: "failed", errorMessage: message, failedAtStatus: currentStatus }).catch(() => {});
    }
  });
}

// ─── Job creators ─────────────────────────────────────────────────────────────

function normalizeVoiceId(v: string | null | undefined): string | null {
  if (!v) return null;
  return VOICE_IDS.has(v) ? v : null;
}

export async function createFileJob(
  fileKey: string,
  originalFilename: string,
  userId?: number,
  localPath?: string,
  sourceLang = "auto",
  targetLang = "he",
  subtitlePosition = "bottom",
  voiceId: string | null = null,
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
    voiceId: normalizeVoiceId(voiceId),
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
  voiceId: string | null = null,
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
    voiceId: normalizeVoiceId(voiceId),
  });
  setImmediate(() => runPipeline(id).catch((err: unknown) => logger.error({ err, jobId: id }, "pipeline error")));
  return id;
}
