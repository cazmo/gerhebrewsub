import { nanoid } from "nanoid";

interface CaptureEntry {
  url: string;
  jobId: string | null;
  expiresAt: number;
  setupOnly?: boolean;
  setupDone?: boolean;
}

const store = new Map<string, CaptureEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store) {
    if (now > v.expiresAt) store.delete(k);
  }
}, 60_000);

export function createCapture(url: string): string {
  const token = nanoid();
  store.set(token, { url, jobId: null, expiresAt: Date.now() + 30 * 60_000 });
  return token;
}

export function createSetupCapture(): string {
  const token = nanoid();
  store.set(token, { url: "__setup__", jobId: null, expiresAt: Date.now() + 30 * 60_000, setupOnly: true, setupDone: false });
  return token;
}

export function getCapture(token: string): CaptureEntry | undefined {
  return store.get(token);
}

export function setJobId(token: string, jobId: string): void {
  const entry = store.get(token);
  if (entry) entry.jobId = jobId;
}

export function isSetupComplete(token: string): boolean {
  return store.get(token)?.setupDone === true;
}

export function markSetupComplete(token: string): void {
  const entry = store.get(token);
  if (entry) entry.setupDone = true;
}
