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
  style?: OcrFrameStyle;
}

interface OcrFrameStyle {
  yCenter: number; // 0..1
  xCenter: number; // 0..1
  height: number;  // 0..1
  width: number;   // 0..1
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
const SUBTITLE_CHUNK_SECONDS = 6; // split audio into 6-sec pieces for tight speech-to-subtitle sync
const MAX_SUBTITLE_LINE_CHARS = 42; // per project spec: 2-line subs ≤42 chars each
const TRANSCRIBE_TIMEOUT_MS = 3 * 60 * 1000;

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
 * Transcribe a single audio chunk (≤25MB) using gpt-4o-mini-transcribe with
 * json response_format. Returns the raw text for this chunk.
 */
async function transcribeChunkText(
  openai: OpenAI,
  audioPath: string,
  sourceLang: string,
): Promise<string> {
  const { createReadStream, statSync } = await import("fs");
  const size = statSync(audioPath).size;
  if (size === 0) return "";

  const langParam = sourceLang !== "auto" ? sourceLang : undefined;
  const fileStream = createReadStream(audioPath);

  const result = await openai.audio.transcriptions.create(
    {
      file: fileStream as never,
      model: "gpt-4o-mini-transcribe",
      ...(langParam ? { language: langParam } : {}),
      response_format: "json",
    },
    { timeout: TRANSCRIBE_TIMEOUT_MS }
  );
  return result.text?.trim() ?? "";
}

/**
 * Split audio into SUBTITLE_CHUNK_SECONDS-long pieces and transcribe each one.
 * Each piece gets exact timestamps from its position → many timed segments.
 */
async function transcribeWithWhisper(audioPath: string, sourceLang: string): Promise<WhisperSegment[]> {
  const openai = getOpenAI();
  const totalDuration = await getAudioDuration(audioPath);

  if (totalDuration <= 0) return [];

  const numChunks = Math.ceil(totalDuration / SUBTITLE_CHUNK_SECONDS);
  const allSegments: WhisperSegment[] = [];

  // Process chunks in parallel groups of 8 to stay within rate limits
  const PARALLEL = 8;
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
          "-acodec", "libmp3lame", "-q:a", "4",
          chunkPath,
        ]).catch(() => null);
      })
    );

    // Transcribe all chunks in this group in parallel
    const texts = await Promise.all(
      chunkPaths.map((cp, idx) => {
        const i = g + idx;
        const startSec = i * SUBTITLE_CHUNK_SECONDS;
        const endSec = Math.min(startSec + SUBTITLE_CHUNK_SECONDS, totalDuration);
        return transcribeChunkText(openai, cp, sourceLang)
          .then((text) => ({ text, startSec, endSec }))
          .catch(() => ({ text: "", startSec, endSec }));
      })
    );

    // Cleanup chunk files
    await Promise.all(chunkPaths.map((cp) => fs.unlink(cp).catch(() => {})));

    // Build segments — split long chunk text into multiple sub-subtitles
    for (const { text, startSec, endSec } of texts) {
      if (!text) continue;
      const pieces = splitTextIntoSubtitlePieces(text, MAX_SUBTITLE_LINE_CHARS * 2).filter((p) => p.length > 0);
      if (pieces.length === 0) continue;
      const span = Math.max(endSec - startSec, 0.5);
      const sliceDur = span / pieces.length;
      for (let p = 0; p < pieces.length; p++) {
        const subStart = startSec + p * sliceDur;
        const subEnd = Math.min(startSec + (p + 1) * sliceDur, endSec);
        if (subEnd - subStart < 0.2) continue; // skip impossibly short slices
        allSegments.push({
          id: allSegments.length,
          start: subStart,
          end: subEnd,
          text: pieces[p],
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

const OCR_INTERVAL_SEC = 2; // sample frame every 2s for tight sync with burned-in subs
const OCR_PARALLEL = 8;

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
    const style: OcrFrameStyle = {
      yCenter: num(obj.yCenter, 0.9),
      xCenter: num(obj.xCenter, 0.5),
      height: num(obj.height, 0.06),
      width: num(obj.width, 0.6),
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
  await execFileAsync("ffmpeg", [
    "-i", videoPath,
    "-vf", `fps=1/${OCR_INTERVAL_SEC}`,
    "-q:v", "2",
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
              model: "gpt-4.1-mini",
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
                    {
                      type: "text",
                      text:
                        `Look at this video frame. If there are burned-in subtitles or on-screen text overlays, ` +
                        `translate them to ${targetLangName}. Return STRICT JSON ONLY (no markdown, no commentary) ` +
                        `with this EXACT shape — ALL FIELDS REQUIRED when text is present:\n` +
                        `{"text":"<translation, max 80 chars, no quotes>","yCenter":<0..1>,"xCenter":<0..1>,"height":<0..1>,"width":<0..1>,"color":"#RRGGBB","outlineColor":"#RRGGBB","hasBox":<true|false>,"bgColor":"#RRGGBB","bold":<true|false>}\n` +
                        `Coordinate rules (CRITICAL — measure carefully):\n` +
                        `- yCenter/xCenter = the CENTER of the original text's bounding box, normalized 0..1 ` +
                        `(x=0 left edge, x=1 right edge; y=0 top edge, y=1 bottom edge).\n` +
                        `- height = vertical size of the text (cap to baseline), normalized 0..1. For typical subtitles this is ~0.05–0.10.\n` +
                        `- width = horizontal extent of the text, normalized 0..1.\n` +
                        `Style rules:\n` +
                        `- color = dominant TEXT fill color in hex (usually #FFFFFF for white subs, #FFFF00 for yellow).\n` +
                        `- outlineColor = the color of the thin stroke/outline around each letter (usually #000000). If no visible outline, use "#000000".\n` +
                        `- hasBox = true ONLY if the text clearly sits on top of a solid or translucent rectangular box/strip behind it (common in news tickers, lyric karaoke). false if the text is rendered directly over the video pixels with just an outline.\n` +
                        `- bgColor = the color of that box (only meaningful when hasBox=true). If unsure use "#000000".\n` +
                        `- bold = true if the text is clearly bold/heavy weight, otherwise false.\n` +
                        `NEVER guess geometry — measure from the actual pixels. Subtitles may be at the top, middle, or bottom — do NOT assume bottom.\n` +
                        `If there is NO readable subtitle/overlay text (ignore small logos/watermarks like brand badges in corners), ` +
                        `return exactly {"text":"NONE"}.`,
                    },
                  ],
                },
              ],
              max_tokens: 200,
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

  // Bridge transient OCR misses: if a single empty frame sits between two text
  // frames, copy the previous text into it so coverage is continuous through
  // the whole video instead of breaking into many short segments with gaps.
  for (let k = 1; k < perFrame.length - 1; k++) {
    if (!perFrame[k].text && perFrame[k - 1].text && perFrame[k + 1].text) {
      perFrame[k].text = perFrame[k - 1].text;
      perFrame[k].style = perFrame[k - 1].style;
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
    const start = i * OCR_INTERVAL_SEC;
    const end = j * OCR_INTERVAL_SEC;
    const styles = perFrame.slice(i, j).map((p) => p.style).filter((s): s is OcrFrameStyle => !!s);
    let avgStyle: OcrFrameStyle | undefined;
    if (styles.length > 0) {
      const numericKeys = ["yCenter", "xCenter", "height", "width"] as const;
      const avg = (k: typeof numericKeys[number]): number =>
        styles.reduce((acc, s) => acc + s[k], 0) / styles.length;
      const boxVotes = styles.filter((s) => s.hasBox).length;
      const boldVotes = styles.filter((s) => s.bold).length;
      avgStyle = {
        yCenter: avg("yCenter"),
        xCenter: avg("xCenter"),
        height: avg("height"),
        width: avg("width"),
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
  primary: string;                                 // ASS PrimaryColour (text fill)
  outline: string;                                 // ASS OutlineColour
  back: string;                                    // ASS BackColour (used when hasBox)
  hasBox: boolean;
  bold: boolean;
  textW: number;                                   // pixel width of original text bbox
  textH: number;                                   // pixel height of original text bbox
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
    // Font size matched to the OCR-detected glyph height. 1.05× compensates
    // for the OCR usually under-reporting (it measures cap height, not full
    // line height with descenders). Wider clamp so big on-screen titles
    // aren't shrunk.
    const detectedFs = Math.round(st.height * videoH * 1.05);
    const fontSize = Math.max(16, Math.min(140, detectedFs || Math.round(videoH * 0.055)));
    const cx = Math.max(0, Math.min(videoW, Math.round(st.xCenter * videoW)));
    const cy = Math.max(0, Math.min(videoH, Math.round(st.yCenter * videoH)));
    const textH = Math.max(8, Math.round(st.height * videoH));
    const textW = Math.max(20, Math.round(st.width * videoW));
    // Mask box — tight rectangle that fully covers the original text plus a
    // generous margin for outline/shadow. Drawn as a solid black box (see
    // embedSubtitles), guaranteeing zero residue. Width gets +30% margin
    // (outline + side glow), height gets +60% (descenders, top accents,
    // drop shadow).
    const maskW = Math.min(videoW - 4, Math.max(40, Math.round(textW * 1.3)));
    const maskH = Math.min(videoH - 4, Math.max(20, Math.round(textH * 1.6)));
    const bw = maskW;
    const bh = maskH;
    const bx = Math.max(2, Math.min(videoW - bw - 2, cx - Math.round(bw / 2)));
    const by = Math.max(2, Math.min(videoH - bh - 2, cy - Math.round(bh / 2)));
    out.push({
      start: seg.start, end: seg.end, text,
      bx, by, bw, bh, cx, cy, fontSize,
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
): string {
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
    "Style: Cover,DejaVu Sans,10,&H00000000,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1\n" +
    "\n" +
    "[Events]\n" +
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";

  const events: string[] = [];
  for (const seg of layout) {
    const start = secondsToAssTime(seg.start);
    const end = secondsToAssTime(seg.end);
    const wrapped = formatSubtitleLines(seg.text);
    const safe = escapeAssText(wrapped).replace(/\n/g, "\\N");
    const bold = seg.bold ? 1 : 0;
    // BorderStyle 4 = opaque box behind text (uses BackColour); 1 = outline+shadow.
    const border = seg.hasBox ? 4 : 1;
    const outlineW = seg.hasBox ? 0 : 2;
    const shadowW = seg.hasBox ? 0 : 1;
    const textOverride =
      `{\\an5\\pos(${seg.cx},${seg.cy})\\fs${seg.fontSize}` +
      `\\c${seg.primary}\\3c${seg.outline}\\4c${seg.back}` +
      `\\bord${outlineW}\\shad${shadowW}\\b${bold}\\bs${border}}`;
    events.push(
      `Dialogue: 1,${start},${end},Default,,0,0,0,,${textOverride}${safe}`,
    );
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
  const useGraph = !!(delogoRegions && delogoRegions.length > 0);
  let graph = "";

  if (useGraph && delogoRegions) {
    // Erase original burned-in subtitles by HEAVILY BLURRING the tight text
    // region — this destroys the glyph edges while blending naturally into
    // the surrounding video colors (no visible black box). The translated
    // subtitle is drawn afterwards at the same cx/cy with the same font
    // size, color, outline, and box style as the OCR-detected original.
    //
    // Chain per-region split → crop → boxblur → overlay. Each pass operates
    // only inside the segment's display window.
    let prev = "0:v";
    for (let i = 0; i < delogoRegions.length; i++) {
      const r = delogoRegions[i];
      const x = Math.max(0, r.bx);
      const y = Math.max(0, r.by);
      const w = Math.max(2, Math.min(r.bw, 99999));
      const h = Math.max(2, r.bh);
      const s = r.start.toFixed(2);
      const e = r.end.toFixed(2);
      const mainLabel = `m${i}`;
      const srcLabel = `s${i}`;
      const blurLabel = `b${i}`;
      const outLabel = `v${i}`;
      // luma_radius/chroma_radius=20, 4 passes => obliterates text completely
      // and produces a smooth color matching the surroundings.
      graph += `[${prev}]split=2[${mainLabel}][${srcLabel}];`;
      graph += `[${srcLabel}]crop=${w}:${h}:${x}:${y},boxblur=lr=15:cr=15:luma_power=4:chroma_power=4[${blurLabel}];`;
      graph += `[${mainLabel}][${blurLabel}]overlay=${x}:${y}:enable='between(t,${s},${e})'[${outLabel}];`;
      prev = outLabel;
    }
    // Translated subtitle render on the cleaned video.
    const subChain: string[] = [`subtitles=${escapedPath}`];
    if (extraBottomSrtPath) {
      const extraEscaped = escapeFfmpegSubPath(extraBottomSrtPath);
      const extraStyle = [
        "FontName=DejaVu Sans","FontSize=26","Alignment=2","MarginV=20",
        "MarginL=40","MarginR=40","PrimaryColour=&H00FFFFFF",
        "OutlineColour=&H00000000","BackColour=&HCC000000",
        "BorderStyle=3","Outline=4","Shadow=0","Bold=0","WrapStyle=2",
      ].join(",");
      subChain.push(`subtitles=${extraEscaped}:force_style='${extraStyle}'`);
    }
    graph += `[${prev}]${subChain.join(",")}[vout]`;
  }

  if (!useGraph && isAss) {
    // ASS already encodes per-line position, color and size.
    vfParts.push(`subtitles=${escapedPath}`);
  } else if (!useGraph) {
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

  // Optional extra bottom subtitle band — non-burned flow. In the burned-in
  // (useGraph) flow this is already wired into the filter_complex above.
  if (!useGraph && extraBottomSrtPath) {
    const extraEscaped = escapeFfmpegSubPath(extraBottomSrtPath);
    const extraStyle = [
      "FontName=DejaVu Sans","FontSize=26","Alignment=2","MarginV=20",
      "MarginL=40","MarginR=40","PrimaryColour=&H00FFFFFF",
      "OutlineColour=&H00000000","BackColour=&HCC000000",
      "BorderStyle=3","Outline=4","Shadow=0","Bold=0","WrapStyle=2",
    ].join(",");
    vfParts.push(`subtitles=${extraEscaped}:force_style='${extraStyle}'`);
  }

  const ffmpegArgs = useGraph
    ? [
        "-y", "-i", videoPath,
        "-filter_complex", graph,
        "-map", "[vout]", "-map", "0:a?",
        "-c:a", "copy",
        "-preset", "fast",
        "-movflags", "+faststart",
        outputPath,
      ]
    : [
        "-y", "-i", videoPath,
        "-vf", vfParts.join(","),
        "-c:a", "copy",
        "-preset", "fast",
        "-movflags", "+faststart",
        outputPath,
      ];
  await execFileAsync("ffmpeg", ffmpegArgs);
}

// ─── TTS dubbing ─────────────────────────────────────────────────────────────

const TTS_CONCURRENCY = 6;

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
          // No audio → assume burned-in if any text frames exist
          hasBurnedInSubs = true;
        }
      } catch {
        hasBurnedInSubs = false;
      }

      // Preserve the original spoken-audio segments — they are used to build
      // the bottom subtitle strip (translation of the SPEAKER), independently
      // of the burned-in on-screen text that goes in the in-place overlay.
      const spokenSegments: WhisperSegment[] = whisperSegments.slice();

      // When burned-in subs detected → OCR-translate them and use those
      // segments as the in-place subtitle source. The OCR timing tracks the
      // actual on-screen subtitle display, so correlation is correct.
      if (hasBurnedInSubs) {
        const ocrResult = await extractTextViaOcr(videoPath, tmpDir, targetLang);
        if (ocrResult.segments.length > 0) {
          whisperSegments = ocrResult.segments;
          burnedInTranslatedAlready = true; // OCR already returned target-lang text
          hasBurnedInSubs = ocrResult.hasBurnedInSubs;
          await updateJob(jobId, { hasBurnedInSubs: true });
        } else if (whisperSegments.length === 0) {
          // No audio AND no OCR text → bail out below
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
        const assContent = buildAssFromBurnedSegments(layout, vidW, vidH);
        const assPath = path.join(tmpDir, "subtitles.ass");
        await fs.writeFile(assPath, assContent, "utf8");
        // Burn ASS (in-place replacement) AND bottom strip from spoken SRT
        // (falls back to OCR SRT if no spoken segments).
        const bottomSrt = spokenSubs.length > 0 ? spokenSrtPath : srtPath;
        await embedSubtitles(videoPath, assPath, outputVideoPath, true, subtitlePosition, layout, bottomSrt);
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

      const outputKey = `outputs/${jobId}/${nanoid(8)}.mp4`;
      const srtKey = `outputs/${jobId}/subtitles.srt`;

      const [outputBuffer] = await Promise.all([
        fs.readFile(outputVideoPath),
        gcsUpload(srtKey, Buffer.from(srtContent, "utf8"), "text/plain"),
      ]);
      await gcsUpload(outputKey, outputBuffer, "video/mp4");
      await gcsEnsurePublic(outputKey);

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
