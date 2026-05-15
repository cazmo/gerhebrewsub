import { describe, expect, it, vi, beforeEach } from "vitest";
import { appRouter } from "./routers";
import { COOKIE_NAME } from "../shared/const";
import type { TrpcContext } from "./_core/context";

// ── Mock DB & pipeline ────────────────────────────────────────────────────────
vi.mock("./db", () => ({
  getJobById: vi.fn(),
  listJobs: vi.fn(),
  createJob: vi.fn(),
  updateJob: vi.fn(),
  insertSegments: vi.fn(),
}));

vi.mock("./pipeline", () => ({
  createFileJob: vi.fn(),
  createYouTubeJob: vi.fn(),
  runPipeline: vi.fn(),
}));

vi.mock("./storage", () => ({
  storagePut: vi.fn(),
  storageGet: vi.fn(),
  storageGetSignedUrl: vi.fn(),
}));

import { getJobById, listJobs } from "./db";
import { createFileJob, createYouTubeJob } from "./pipeline";
import { storagePut } from "./storage";

// ── Context helpers ───────────────────────────────────────────────────────────
type AuthUser = NonNullable<TrpcContext["user"]>;

function makeCtx(user?: AuthUser): TrpcContext {
  return {
    user: user ?? null,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {
      clearCookie: vi.fn(),
    } as unknown as TrpcContext["res"],
  };
}

const SAMPLE_USER: AuthUser = {
  id: 1,
  openId: "test-user",
  email: "test@example.com",
  name: "Test User",
  loginMethod: "manus",
  role: "user",
  createdAt: new Date(),
  updatedAt: new Date(),
  lastSignedIn: new Date(),
};

const SAMPLE_JOB = {
  id: "job-123",
  userId: 1,
  status: "completed" as const,
  inputType: "file" as const,
  inputUrl: null,
  inputKey: "uploads/test.mp4",
  originalFilename: "test.mp4",
  outputKey: "outputs/job-123/video-hebrew_abc12345.mp4",
  outputUrl: "/manus-storage/outputs/job-123/video-hebrew_abc12345.mp4",
  errorMessage: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("auth.logout", () => {
  it("clears the session cookie and returns success", async () => {
    const ctx = makeCtx(SAMPLE_USER);
    const caller = appRouter.createCaller(ctx);
    const result = await caller.auth.logout();
    expect(result).toEqual({ success: true });
    expect(ctx.res.clearCookie).toHaveBeenCalledWith(
      COOKIE_NAME,
      expect.objectContaining({ maxAge: -1 })
    );
  });
});

describe("jobs.get", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a job by ID", async () => {
    vi.mocked(getJobById).mockResolvedValue(SAMPLE_JOB);
    const caller = appRouter.createCaller(makeCtx());
    const result = await caller.jobs.get({ id: "job-123" });
    expect(result.id).toBe("job-123");
    expect(result.status).toBe("completed");
  });

  it("throws NOT_FOUND when job does not exist", async () => {
    vi.mocked(getJobById).mockResolvedValue(undefined);
    const caller = appRouter.createCaller(makeCtx());
    await expect(caller.jobs.get({ id: "missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("jobs.list", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns list of jobs", async () => {
    vi.mocked(listJobs).mockResolvedValue([SAMPLE_JOB]);
    const caller = appRouter.createCaller(makeCtx());
    const result = await caller.jobs.list();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("job-123");
  });

  it("passes userId when authenticated", async () => {
    vi.mocked(listJobs).mockResolvedValue([]);
    const caller = appRouter.createCaller(makeCtx(SAMPLE_USER));
    await caller.jobs.list();
    expect(listJobs).toHaveBeenCalledWith(1);
  });
});

describe("jobs.startFromFile", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a file job and returns jobId", async () => {
    vi.mocked(createFileJob).mockResolvedValue("new-job-id");
    const caller = appRouter.createCaller(makeCtx(SAMPLE_USER));
    const result = await caller.jobs.startFromFile({
      fileKey: "uploads/video.mp4",
      originalFilename: "video.mp4",
    });
    expect(result.jobId).toBe("new-job-id");
    expect(createFileJob).toHaveBeenCalledWith("uploads/video.mp4", "video.mp4", 1, undefined);
  });
});

describe("jobs.startFromYouTube", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a YouTube job and returns jobId", async () => {
    vi.mocked(createYouTubeJob).mockResolvedValue("yt-job-id");
    const caller = appRouter.createCaller(makeCtx());
    const result = await caller.jobs.startFromYouTube({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(result.jobId).toBe("yt-job-id");
  });

  it("passes cookiesKey when provided", async () => {
    vi.mocked(createYouTubeJob).mockResolvedValue("yt-job-2");
    const caller = appRouter.createCaller(makeCtx());
    await caller.jobs.startFromYouTube({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      cookiesKey: "cookies/cookies-abc.txt",
    });
    expect(createYouTubeJob).toHaveBeenCalledWith(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "cookies/cookies-abc.txt",
      undefined
    );
  });
});

describe("jobs.uploadCookies", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uploads cookies and returns a storage key", async () => {
    vi.mocked(storagePut).mockResolvedValue({ key: "cookies/cookies-xyz.txt", url: "/manus-storage/cookies/cookies-xyz.txt" });
    const caller = appRouter.createCaller(makeCtx());
    const b64 = Buffer.from("# cookies content").toString("base64");
    const result = await caller.jobs.uploadCookies({ content: b64 });
    expect(result.key).toMatch(/^cookies\/cookies-/);
    expect(storagePut).toHaveBeenCalled();
  });
});

describe("jobs.getDownloadUrl", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a /manus-download/ URL for completed jobs", async () => {
    vi.mocked(getJobById).mockResolvedValue(SAMPLE_JOB);
    const caller = appRouter.createCaller(makeCtx());
    const result = await caller.jobs.getDownloadUrl({ id: "job-123" });
    expect(result.url).toMatch(/^\/manus-download\//);
  });

  it("throws BAD_REQUEST when job is not completed", async () => {
    vi.mocked(getJobById).mockResolvedValue({ ...SAMPLE_JOB, status: "transcribing", outputKey: null });
    const caller = appRouter.createCaller(makeCtx());
    await expect(caller.jobs.getDownloadUrl({ id: "job-123" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});
