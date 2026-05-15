import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import multer from "multer";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { storagePut } from "../storage";
import { nanoid } from "nanoid";
import os from "os";
import fsp from "fs/promises";
import pathMod from "path";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

// Multer — disk storage to /tmp, 500 MB limit
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
    if (allowed.includes(file.mimetype) || file.originalname.match(/\.(mp4|mpeg|mov|avi|webm|mkv)$/i)) {
      cb(null, true);
    } else {
      cb(new Error("סוג קובץ לא נתמך. יש להעלות קובץ וידאו."));
    }
  },
});

const MULTER_ERROR_MAP: Record<string, string> = {
  LIMIT_FILE_SIZE: "הקובץ גדול מדי. הגודל המקסימלי הוא 500MB.",
  LIMIT_UNEXPECTED_FILE: "שדה קובץ לא צפוי.",
  LIMIT_FILE_COUNT: "יותר מדי קבצים.",
};

async function startServer() {
  const app = express();
  const server = createServer(app);

  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  registerStorageProxy(app);
  registerOAuthRoutes(app);

  // ── File upload endpoint ──────────────────────────────────────────────────
  // Strategy: multer writes to /tmp disk; pipeline reads from localPath directly.
  // Also uploads to S3 for output-download long-term storage.
  app.post("/api/upload", upload.single("video"), async (req, res) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: "לא הועלה קובץ" });
        return;
      }
      const ext = pathMod.extname(req.file.originalname) || ".mp4";
      const key = `uploads/${nanoid()}${ext}`;
      // Upload to S3 for long-term storage
      const fileBuffer = await fsp.readFile(req.file.path);
      await storagePut(key, fileBuffer, req.file.mimetype);
      // Return localPath so the pipeline can read directly from disk (no S3 re-download)
      res.json({ key, localPath: req.file.path, originalFilename: req.file.originalname });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "שגיאת העלאה";
      res.status(500).json({ error: msg });
    }
  });

  // Multer error handler
  app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err && typeof err === "object" && "code" in err) {
      const code = (err as { code: string }).code;
      const msg = MULTER_ERROR_MAP[code] ?? "שגיאה בהעלאת הקובץ";
      res.status(400).json({ error: msg });
      return;
    }
    next(err);
  });

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );

  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);
  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
