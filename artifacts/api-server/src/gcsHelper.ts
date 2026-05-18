import { Storage } from "@google-cloud/storage";

const SIDECAR = "http://127.0.0.1:1106";

export const gcsClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${SIDECAR}/token`,
    type: "external_account",
    credential_source: {
      url: `${SIDECAR}/credential`,
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  } as never,
  projectId: "",
});

function getBucketId(): string {
  const id = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  if (!id) throw new Error("DEFAULT_OBJECT_STORAGE_BUCKET_ID not set");
  return id;
}

export function gcsBucket() {
  return gcsClient.bucket(getBucketId());
}

export async function gcsUpload(
  key: string,
  data: Buffer,
  contentType = "application/octet-stream"
): Promise<void> {
  await gcsBucket().file(key).save(data, { contentType, resumable: false });
}

export async function gcsDownload(key: string): Promise<Buffer> {
  const [buf] = await gcsBucket().file(key).download();
  return buf as Buffer;
}

export const GLOBAL_COOKIES_KEY = "cookies/global-youtube.txt";

export async function globalCookiesExist(): Promise<boolean> {
  try {
    const [exists] = await gcsBucket().file(GLOBAL_COOKIES_KEY).exists();
    return exists;
  } catch {
    return false;
  }
}

export async function loadGlobalCookies(): Promise<Buffer | null> {
  try {
    return await gcsDownload(GLOBAL_COOKIES_KEY);
  } catch {
    return null;
  }
}

export async function saveGlobalCookies(data: Buffer): Promise<void> {
  await gcsUpload(GLOBAL_COOKIES_KEY, data, "text/plain");
}

export async function deleteGlobalCookies(): Promise<void> {
  try {
    await gcsBucket().file(GLOBAL_COOKIES_KEY).delete();
  } catch {
    // ignore if not found
  }
}

export async function gcsSignedGetUrl(
  key: string,
  expiresInSeconds = 3600,
  contentDisposition?: string,
): Promise<string> {
  const [url] = await gcsBucket().file(key).getSignedUrl({
    version: "v4",
    action: "read",
    expires: Date.now() + expiresInSeconds * 1000,
    ...(contentDisposition ? { responseDisposition: contentDisposition } : {}),
  });
  return url;
}

export async function gcsSignedPutUrl(
  key: string,
  contentType: string,
  expiresInSeconds = 900
): Promise<string> {
  const [url] = await gcsBucket().file(key).getSignedUrl({
    version: "v4",
    action: "write",
    expires: Date.now() + expiresInSeconds * 1000,
    contentType,
  });
  return url;
}
