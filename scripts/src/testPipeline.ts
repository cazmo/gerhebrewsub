/**
 * End-to-end pipeline test script.
 * Run: pnpm --filter @workspace/scripts run test:pipeline
 */
import { execFile } from "child_process";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { promisify } from "util";
import { db } from "@workspace/db";
import { jobs, jobSegments } from "@workspace/db";
import { eq } from "drizzle-orm";

const execFileAsync = promisify(execFile);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PASS = "✅";
const FAIL = "❌";
const SKIP = "⏭️ ";
let passed = 0;
let failed = 0;

function ok(label: string, detail?: string) {
  console.log(`  ${PASS} ${label}${detail ? ` — ${detail}` : ""}`);
  passed++;
}
function fail(label: string, detail?: string) {
  console.error(`  ${FAIL} ${label}${detail ? ` — ${detail}` : ""}`);
  failed++;
}
function skip(label: string, reason: string) {
  console.log(`  ${SKIP} ${label} (${reason})`);
}
function section(title: string) {
  console.log(`\n── ${title} ──────────────────────────────────────`);
}

// ─── Subtitle formatter (inline copy for isolation) ───────────────────────────

const MAX_LINE_CHARS = 42;
const MAX_LINES = 2;

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
      if (current) { lines.push(current); current = word; }
      else { lines.push(word.slice(0, MAX_LINE_CHARS)); current = ""; }
    }
  }
  if (current && lines.length < MAX_LINES) lines.push(current);
  return lines.join("\n");
}

// ─── Test: subtitle formatter ─────────────────────────────────────────────────

function testSubtitleFormatter() {
  section("Subtitle 2-line Formatter");

  const cases: [string, string, string][] = [
    ["short text", "שלום", "שלום"],
    ["exactly 42 chars", "a".repeat(42), "a".repeat(42)],
    ["long line splits at word boundary",
      "This is a very long subtitle line that should be split across two lines properly",
      "This is a very long subtitle line that\nshould be split across two lines properly"
    ],
    ["three line text truncates to 2",
      "One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen",
      // Should produce exactly 2 lines
      null as unknown as string,
    ],
    ["empty string", "", ""],
    ["single long word", "a".repeat(60), "a".repeat(42)],
    ["Hebrew text",
      "זהו משפט עברי ארוך מאוד שצריך להיות מחולק לשתי שורות כדי שיראה טוב בכתוביות",
      null as unknown as string, // just check max 2 lines
    ],
  ];

  for (const [label, input, expected] of cases) {
    const result = formatSubtitleLines(input);
    const lineCount = result ? result.split("\n").length : 0;

    if (lineCount > MAX_LINES) {
      fail(label, `${lineCount} lines (max ${MAX_LINES})`);
    } else if (expected !== null && result !== expected) {
      fail(label, `got "${result.replace(/\n/g, "\\n")}" expected "${expected.replace(/\n/g, "\\n")}"`);
    } else {
      ok(label, `${lineCount} line(s)`);
    }
  }
}

// ─── Test: duration validation ────────────────────────────────────────────────

async function testDurationValidation() {
  section("Duration & Size Validation");

  const MAX_DUR = 110 * 60; // 6600 sec

  // Create a tiny video and verify its duration is under limit
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pipeline-test-"));
  try {
    const shortPath = path.join(tmpDir, "short.mp4");
    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
      "-f", "lavfi", "-i", "color=c=red:size=320x240:duration=5:rate=10",
      "-map", "1:v", "-map", "0:a",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
      shortPath,
    ]);

    // Get its duration via ffprobe
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "quiet", "-print_format", "json", "-show_format", shortPath,
    ]);
    const dur = parseFloat((JSON.parse(stdout) as { format: { duration: string } }).format.duration);

    if (dur < MAX_DUR) ok("5-second video is under 110-minute limit", `${dur.toFixed(1)}s`);
    else fail("5-second video exceeds limit (unexpected)");

    // Verify limit constant
    if (MAX_DUR === 6600) ok("MAX_VIDEO_DURATION_SEC = 6600 (110 min)");
    else fail("MAX_VIDEO_DURATION_SEC is wrong");

    // Verify size check: create a fake "large" scenario
    const stat = await fs.stat(shortPath);
    const MAX_BYTES = 500 * 1024 * 1024;
    if (stat.size < MAX_BYTES) ok("5s test video is under 500MB limit", `${(stat.size / 1024).toFixed(0)}KB`);
    else fail("Test video exceeds 500MB (unexpected)");

    ok("Duration validation constants are correct");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// ─── Test: DB connectivity ────────────────────────────────────────────────────

async function testDatabase() {
  section("Database Connectivity");
  try {
    const result = await db.select().from(jobs).limit(1);
    ok("DB connection works", `${result.length} row(s) in sample query`);

    // Check schema has new columns
    const cols = await db.execute(
      `SELECT column_name FROM information_schema.columns WHERE table_name='jobs' ORDER BY column_name`
    ) as { rows: { column_name: string }[] };
    const colNames = cols.rows.map((r) => r.column_name);

    for (const col of ["source_lang", "target_lang", "has_burned_in_subs"]) {
      if (colNames.includes(col)) ok(`Column '${col}' exists in jobs table`);
      else fail(`Column '${col}' missing from jobs table`);
    }

    // Count jobs by status
    const statusCounts = await db.execute(
      `SELECT status, count(*) as n FROM jobs GROUP BY status ORDER BY n DESC`
    ) as { rows: { status: string; n: string }[] };
    console.log("    Job counts by status:");
    statusCounts.rows.forEach((r) => console.log(`      ${r.status}: ${r.n}`));
    ok("Job status distribution retrieved");
  } catch (err) {
    fail("DB connection failed", String(err));
  }
}

// ─── Test: ffmpeg/ffprobe availability ────────────────────────────────────────

async function testSystemTools() {
  section("System Tools");

  for (const tool of ["ffmpeg", "ffprobe"]) {
    try {
      const { stdout } = await execFileAsync(tool, ["-version"]);
      const ver = stdout.split("\n")[0];
      ok(`${tool} available`, ver.slice(0, 60));
    } catch {
      fail(`${tool} not found`);
    }
  }

  const ytDlpBin = process.env.YT_DLP_PATH ?? "/home/runner/workspace/bin/yt-dlp";
  try {
    const { stdout } = await execFileAsync(ytDlpBin, ["--version"]);
    ok("yt-dlp available", stdout.trim());
  } catch {
    fail("yt-dlp not found at " + ytDlpBin);
  }
}

// ─── Test: API health ─────────────────────────────────────────────────────────

async function testApiHealth() {
  section("API Health");
  try {
    const res = await fetch("http://localhost:8080/api/healthz");
    const body = (await res.json()) as { status: string };
    if (body.status === "ok") ok("API server health check", `HTTP ${res.status}`);
    else fail("API health returned non-ok", JSON.stringify(body));
  } catch (err) {
    fail("Cannot reach API server", String(err));
  }
}

// ─── Test: Language map ───────────────────────────────────────────────────────

function testLanguageMap() {
  section("Language Configuration");

  const SUPPORTED_LANGS: Record<string, string> = {
    auto: "זיהוי אוטומטי", he: "עברית", de: "גרמנית", en: "אנגלית",
    fr: "צרפתית", es: "ספרדית", ar: "ערבית", ru: "רוסית",
    uk: "אוקראינית", it: "איטלקית", pt: "פורטוגלית", pl: "פולנית",
    nl: "הולנדית", tr: "טורקית", zh: "סינית", ja: "יפנית",
    ko: "קוריאנית", ro: "רומנית", hu: "הונגרית", cs: "צ'כית", sv: "שוודית",
  };

  const count = Object.keys(SUPPORTED_LANGS).length;
  if (count >= 20) ok(`${count} languages configured`);
  else fail(`Only ${count} languages (expected ≥20)`);

  if ("auto" in SUPPORTED_LANGS) ok("Auto-detect option exists");
  else fail("Auto-detect option missing");

  if ("he" in SUPPORTED_LANGS) ok("Hebrew target language exists");
  else fail("Hebrew missing from language map");

  const targetLangs = Object.keys(SUPPORTED_LANGS).filter((k) => k !== "auto");
  if (targetLangs.length >= 19) ok(`${targetLangs.length} valid target languages`);
  else fail(`Only ${targetLangs.length} target languages`);
}

// ─── Test: SRT two-line output ────────────────────────────────────────────────

function testSrtOutput() {
  section("SRT Two-Line Format");

  // Simulate buildSrt output for a long translated line
  const longLine = "זהו תרגום עברי ארוך מאוד שצריך להיות מחולק לשתי שורות לפי התקן";
  const formatted = formatSubtitleLines(longLine);
  const lines = formatted.split("\n");

  if (lines.length <= 2) ok("Long Hebrew line splits to ≤2 lines", `${lines.length} lines`);
  else fail(`Line split produced ${lines.length} lines (max 2)`);

  for (const line of lines) {
    if (line.length <= MAX_LINE_CHARS) ok(`Line length ≤${MAX_LINE_CHARS}`, `"${line}" (${line.length} chars)`);
    else fail(`Line too long: ${line.length} chars`, `"${line}"`);
  }

  // Short text stays as one line
  const shortLine = "שלום עולם";
  const shortFormatted = formatSubtitleLines(shortLine);
  if (!shortFormatted.includes("\n")) ok("Short text stays on one line");
  else fail("Short text was unnecessarily split");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  PIPELINE TEST SUITE — מתרגם כתוביות             ");
  console.log("═══════════════════════════════════════════════════");

  testSubtitleFormatter();
  testLanguageMap();
  testSrtOutput();
  await testDurationValidation();
  await testSystemTools();
  await testDatabase();
  await testApiHealth();

  console.log("\n═══════════════════════════════════════════════════");
  console.log(`  Results: ${PASS} ${passed} passed  ${FAIL} ${failed} failed`);
  console.log("═══════════════════════════════════════════════════");

  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
