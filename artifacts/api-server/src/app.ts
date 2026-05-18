import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import multer from "multer";
import os from "os";
import pathMod from "path";
import { promises as fs } from "fs";
import { nanoid } from "nanoid";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";
import { appRouter } from "./trpcRouter.js";
import { getJobById } from "./db.js";
import { gcsBucket, gcsUpload, gcsSignedGetUrl, saveGlobalCookies } from "./gcsHelper.js";
import { getCapture, setJobId, createSetupCapture, markSetupComplete } from "./captureStore.js";
import { createYouTubeJob } from "./pipeline.js";

interface ChunkSession {
  path: string;
  filename: string;
  totalChunks: number;
  received: Set<number>;
  createdAt: number;
}
const CHUNK_SESSIONS = new Map<string, ChunkSession>();

setInterval(() => {
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  const now = Date.now();
  for (const [id, s] of CHUNK_SESSIONS.entries()) {
    if (now - s.createdAt > TWO_HOURS) {
      for (let i = 0; i < s.totalChunks; i++) {
        fs.unlink(`${s.path}.chunk${i}`).catch(() => {});
      }
      fs.unlink(s.path).catch(() => {});
      CHUNK_SESSIONS.delete(id);
    }
  }
}, 30 * 60 * 1000);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, file, cb) => {
      const ext = pathMod.extname(file.originalname) || ".mp4";
      cb(null, `upload_${nanoid()}${ext}`);
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["video/mp4", "video/mpeg", "video/quicktime", "video/x-msvideo", "video/webm", "video/x-matroska"];
    if (allowed.includes(file.mimetype) || /\.(mp4|mpeg|mov|avi|webm|mkv)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error("סוג קובץ לא נתמך. יש להעלות קובץ וידאו."));
    }
  },
});

const MULTER_ERROR_MAP: Record<string, string> = {
  LIMIT_FILE_SIZE: "הקובץ גדול מדי. הגודל המקסימלי הוא 500MB.",
  LIMIT_UNEXPECTED_FILE: "שדה קובץ לא צפוי.",
};

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  })
);
app.use(cors());

app.use(
  "/api/trpc",
  createExpressMiddleware({ router: appRouter, createContext: () => ({}) })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

function jsToNetscapeCookies(cookieStr: string): string {
  const expiry = Math.floor(Date.now() / 1000) + 86400 * 30;
  const lines = ["# Netscape HTTP Cookie File", "# Auto-captured by gerhebrewsub", ""];
  for (const part of cookieStr.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    lines.push(`.youtube.com\tTRUE\t/\tFALSE\t${expiry}\t${name}\t${value}`);
  }
  return lines.join("\n") + "\n";
}

app.post("/api/cookie-relay", async (req, res) => {
  try {
    const { token, cookies } = req.body as { token?: string; cookies?: string };
    if (!token || typeof cookies !== "string") {
      res.status(400).json({ error: "Missing token or cookies" });
      return;
    }
    const entry = getCapture(token);
    if (!entry) {
      res.status(404).json({ error: "Token expired or invalid" });
      return;
    }
    if (entry.jobId) {
      res.json({ jobId: entry.jobId });
      return;
    }
    const netscape = jsToNetscapeCookies(cookies);
    const cookiesBuf = Buffer.from(netscape, "utf8");
    const cookiesKey = `cookies/cookies-${nanoid()}.txt`;
    await gcsUpload(cookiesKey, cookiesBuf, "text/plain");
    await saveGlobalCookies(cookiesBuf).catch(() => {});
    const jobId = await createYouTubeJob(entry.url, cookiesKey);
    setJobId(token, jobId);
    res.json({ jobId });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Server error";
    res.status(500).json({ error: msg });
  }
});

app.post("/api/youtube-connect", async (req, res) => {
  try {
    const { token, cookies } = req.body as { token?: string; cookies?: string };
    if (!token || typeof cookies !== "string") {
      res.status(400).json({ error: "Missing token or cookies" });
      return;
    }
    const entry = getCapture(token);
    if (!entry || !entry.setupOnly) {
      res.status(404).json({ error: "Token expired or invalid" });
      return;
    }
    if (entry.setupDone) {
      res.json({ ok: true });
      return;
    }
    const netscape = jsToNetscapeCookies(cookies);
    await saveGlobalCookies(Buffer.from(netscape, "utf8"));
    markSetupComplete(token);
    res.json({ ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Server error";
    res.status(500).json({ error: msg });
  }
});

app.post("/api/upload", upload.single("video"), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "לא הועלה קובץ" });
      return;
    }
    res.json({
      key: req.file.path,
      localPath: req.file.path,
      originalFilename: req.file.originalname,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "שגיאת העלאה";
    res.status(500).json({ error: msg });
  }
});

const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

app.post("/api/upload/init", (req, res) => {
  try {
    const { filename, totalChunks } = req.body as { filename?: string; totalChunks?: number };
    if (!filename || !totalChunks || totalChunks < 1 || totalChunks > 500) {
      res.status(400).json({ error: "פרמטרים לא תקינים" });
      return;
    }
    const sessionId = nanoid();
    const ext = pathMod.extname(filename) || ".mp4";
    const filePath = pathMod.join(os.tmpdir(), `chunked_${sessionId}${ext}`);
    CHUNK_SESSIONS.set(sessionId, { path: filePath, filename, totalChunks, received: new Set(), createdAt: Date.now() });
    res.json({ sessionId });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : "שגיאה" });
  }
});

app.post("/api/upload/chunk", chunkUpload.single("chunk"), async (req, res) => {
  try {
    const { sessionId, chunkIndex } = req.body as { sessionId?: string; chunkIndex?: string };
    const idx = Number(chunkIndex);
    if (!sessionId || isNaN(idx)) { res.status(400).json({ error: "פרמטרים חסרים" }); return; }
    const session = CHUNK_SESSIONS.get(sessionId);
    if (!session) { res.status(404).json({ error: "session לא נמצא" }); return; }
    if (!req.file) { res.status(400).json({ error: "לא הועלה chunk" }); return; }

    const chunkPath = `${session.path}.chunk${idx}`;
    await fs.writeFile(chunkPath, req.file.buffer);
    session.received.add(idx);

    res.json({ received: session.received.size, total: session.totalChunks });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : "שגיאה" });
  }
});

app.get("/api/upload/status/:sessionId", (req, res) => {
  const session = CHUNK_SESSIONS.get(req.params.sessionId);
  if (!session) { res.status(404).json({ error: "session לא נמצא או פג תוקף" }); return; }
  res.json({ received: [...session.received], totalChunks: session.totalChunks });
});

app.post("/api/upload/finalize", async (req, res) => {
  try {
    const { sessionId } = req.body as { sessionId?: string };
    if (!sessionId) { res.status(400).json({ error: "sessionId חסר" }); return; }
    const session = CHUNK_SESSIONS.get(sessionId);
    if (!session) { res.status(404).json({ error: "session לא נמצא" }); return; }

    if (session.received.size !== session.totalChunks) {
      res.status(400).json({ error: `חסרים chunks: ${session.received.size}/${session.totalChunks}` });
      return;
    }

    const writeStream = (await import("fs")).createWriteStream(session.path);
    for (let i = 0; i < session.totalChunks; i++) {
      const chunkPath = `${session.path}.chunk${i}`;
      const data = await fs.readFile(chunkPath);
      await new Promise<void>((resolve, reject) => {
        writeStream.write(data, (err) => { if (err) reject(err); else resolve(); });
      });
      await fs.unlink(chunkPath).catch(() => {});
    }
    await new Promise<void>((resolve, reject) => writeStream.end((err?: Error | null) => err ? reject(err) : resolve()));

    CHUNK_SESSIONS.delete(sessionId);
    res.json({ key: session.path, localPath: session.path, originalFilename: session.filename });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : "שגיאה" });
  }
});

app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: string }).code;
    const msg = MULTER_ERROR_MAP[code] ?? "שגיאה בהעלאת הקובץ";
    res.status(400).json({ error: msg });
    return;
  }
  next(err);
});

app.get("/api/download/:jobId", async (req, res) => {
  try {
    const job = await getJobById(req.params.jobId);
    if (!job || job.status !== "completed" || !job.outputKey) {
      res.status(404).json({ error: "סרטון לא נמצא" });
      return;
    }
    const filename = `video-subtitled-${req.params.jobId.slice(0, 8)}.mp4`;
    try {
      // Redirect directly to GCS signed URL — bypasses proxy size limits
      const url = await gcsSignedGetUrl(
        job.outputKey,
        3600,
        `attachment; filename="${filename}"`,
      );
      res.redirect(302, url);
    } catch {
      // Fallback: stream through server
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      gcsBucket().file(job.outputKey)
        .createReadStream()
        .on("error", (streamErr) => {
          logger.error({ err: streamErr }, "GCS download error");
          if (!res.headersSent) res.status(500).json({ error: "שגיאה בהורדה" });
        })
        .pipe(res);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "שגיאה";
    res.status(500).json({ error: msg });
  }
});

app.get("/api/stream/:jobId", async (req, res) => {
  try {
    const job = await getJobById(req.params.jobId);
    if (!job || job.status !== "completed" || !job.outputKey) {
      res.status(404).json({ error: "סרטון לא נמצא" });
      return;
    }
    try {
      // Redirect to GCS signed URL — browser handles range requests directly
      const url = await gcsSignedGetUrl(job.outputKey, 3600);
      res.redirect(302, url);
    } catch {
      // Fallback: proxy with range request support
      const file = gcsBucket().file(job.outputKey);
      const [metadata] = await file.getMetadata();
      const fileSize = Number(metadata.size ?? 0);
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Accept-Ranges", "bytes");
      const rangeHeader = req.headers.range;
      if (rangeHeader && fileSize > 0) {
        const parts = rangeHeader.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;
        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
        res.setHeader("Content-Length", chunkSize);
        file.createReadStream({ start, end })
          .on("error", (e) => { if (!res.headersSent) res.status(500).end(); else res.end(); logger.error({ err: e }, "GCS stream error"); })
          .pipe(res);
      } else {
        if (fileSize > 0) res.setHeader("Content-Length", fileSize);
        file.createReadStream()
          .on("error", (e) => { if (!res.headersSent) res.status(500).end(); else res.end(); logger.error({ err: e }, "GCS stream error"); })
          .pipe(res);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "שגיאה";
    if (!res.headersSent) res.status(500).json({ error: msg });
  }
});

app.get("/api/download-srt/:jobId", async (req, res) => {
  try {
    const job = await getJobById(req.params.jobId);
    if (!job || job.status !== "completed" || !job.srtKey) {
      res.status(404).json({ error: "קובץ כתוביות לא נמצא" });
      return;
    }
    const filename = `subtitles-${req.params.jobId.slice(0, 8)}.srt`;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    const file = gcsBucket().file(job.srtKey);
    file.createReadStream()
      .on("error", (streamErr) => {
        logger.error({ err: streamErr }, "GCS SRT download error");
        if (!res.headersSent) res.status(500).json({ error: "שגיאה בהורדה" });
      })
      .pipe(res);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "שגיאה";
    res.status(500).json({ error: msg });
  }
});

export default app;
