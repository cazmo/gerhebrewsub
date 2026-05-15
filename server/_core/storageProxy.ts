import type { Express } from "express";
import { ENV } from "./env";

async function getSignedUrl(key: string): Promise<string> {
  const forgeUrl = new URL(
    "v1/storage/presign/get",
    ENV.forgeApiUrl.replace(/\/+$/, "") + "/"
  );
  forgeUrl.searchParams.set("path", key);

  const forgeResp = await fetch(forgeUrl, {
    headers: { Authorization: `Bearer ${ENV.forgeApiKey}` },
  });

  if (!forgeResp.ok) {
    const body = await forgeResp.text().catch(() => "");
    throw new Error(`Storage backend error: ${forgeResp.status} ${body}`);
  }

  const { url } = (await forgeResp.json()) as { url: string };
  if (!url) throw new Error("Empty signed URL from backend");
  return url;
}

async function pipeStorageFile(
  key: string,
  res: import("express").Response,
  extraHeaders?: Record<string, string>
): Promise<void> {
  const signedUrl = await getSignedUrl(key);
  // Pipe bytes directly — avoids CloudFront IP restrictions on the sandbox
  const s3Res = await fetch(signedUrl);
  if (!s3Res.ok) {
    res.status(502).send("Failed to fetch file from storage");
    return;
  }

  res.set("Cache-Control", "no-store");
  if (s3Res.headers.get("content-type")) {
    res.set("Content-Type", s3Res.headers.get("content-type")!);
  }
  if (s3Res.headers.get("content-length")) {
    res.set("Content-Length", s3Res.headers.get("content-length")!);
  }
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      res.set(k, v);
    }
  }

  const reader = s3Res.body?.getReader();
  if (!reader) {
    res.status(502).send("Empty response from storage");
    return;
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!res.write(value)) {
      await new Promise((r) => res.once("drain", r));
    }
  }
  res.end();
}

export function registerStorageProxy(app: Express) {
  // ── /manus-storage/* — pipe file bytes (works from server-side fetch, no CloudFront IP block) ──
  app.get("/manus-storage/*", async (req, res) => {
    const key = (req.params as Record<string, string>)[0];
    if (!key) { res.status(400).send("Missing storage key"); return; }
    if (!ENV.forgeApiUrl || !ENV.forgeApiKey) {
      res.status(500).send("Storage proxy not configured");
      return;
    }
    try {
      await pipeStorageFile(key, res);
    } catch (err) {
      console.error("[StorageProxy] failed:", err);
      if (!res.headersSent) res.status(502).send("Storage proxy error");
    }
  });

  // ── /manus-download/* — stream file with Content-Disposition: attachment ──
  app.get("/manus-download/*", async (req, res) => {
    const key = (req.params as Record<string, string>)[0];
    if (!key) { res.status(400).send("Missing storage key"); return; }
    if (!ENV.forgeApiUrl || !ENV.forgeApiKey) {
      res.status(500).send("Storage proxy not configured");
      return;
    }

    const filename = (req.query.filename as string) || "video-hebrew.mp4";

    try {
      await pipeStorageFile(key, res, {
        "Content-Type": "video/mp4",
        "Content-Disposition": `attachment; filename="${filename}"`,
      });
    } catch (err) {
      console.error("[DownloadProxy] failed:", err);
      if (!res.headersSent) res.status(502).send("Download proxy error");
    }
  });
}
