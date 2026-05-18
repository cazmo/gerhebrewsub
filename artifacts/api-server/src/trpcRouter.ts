import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import { nanoid } from "nanoid";
import { getJobById, listJobs } from "./db.js";
import { createFileJob, createYouTubeJob, SUPPORTED_LANGS } from "./pipeline.js";
import { gcsUpload, gcsSignedPutUrl, globalCookiesExist, deleteGlobalCookies } from "./gcsHelper.js";
import { createCapture, createSetupCapture, getCapture, isSetupComplete, setJobId } from "./captureStore.js";

const t = initTRPC.create();

const langCodeSchema = z.string().regex(/^[a-z]{2,5}$/).optional();

export const appRouter = t.router({
  jobs: t.router({
    get: t.procedure
      .input(z.object({ id: z.string() }))
      .query(async ({ input }) => {
        const job = await getJobById(input.id);
        if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "עבודה לא נמצאה" });
        return job;
      }),

    list: t.procedure.query(async () => {
      return listJobs();
    }),

    supportedLangs: t.procedure.query(async () => {
      return SUPPORTED_LANGS;
    }),

    getUploadUrl: t.procedure
      .input(
        z.object({
          filename: z.string(),
          contentType: z.string().regex(/^video\//, "סוג קובץ חייב להיות video/*"),
        })
      )
      .mutation(async ({ input }) => {
        const ext = input.filename.split(".").pop() ?? "mp4";
        const key = `uploads/upload_${nanoid()}.${ext}`;
        const uploadUrl = await gcsSignedPutUrl(key, input.contentType);
        return { uploadUrl, key };
      }),

    startFromFile: t.procedure
      .input(
        z.object({
          fileKey: z.string(),
          originalFilename: z.string(),
          localPath: z.string().optional(),
          sourceLang: langCodeSchema,
          targetLang: langCodeSchema,
          subtitlePosition: z.enum(["bottom", "top"]).optional(),
        })
      )
      .mutation(async ({ input }) => {
        const jobId = await createFileJob(
          input.fileKey,
          input.originalFilename,
          undefined,
          input.localPath,
          input.sourceLang ?? "auto",
          input.targetLang ?? "he",
          input.subtitlePosition ?? "bottom",
        );
        return { jobId };
      }),

    startFromYouTube: t.procedure
      .input(
        z.object({
          url: z.string().url(),
          cookiesKey: z.string().optional(),
          sourceLang: langCodeSchema,
          targetLang: langCodeSchema,
          subtitlePosition: z.enum(["bottom", "top"]).optional(),
        })
      )
      .mutation(async ({ input }) => {
        const ALLOWED_HOSTS = [
          "youtube.com", "www.youtube.com", "youtu.be",
          "m.youtube.com", "music.youtube.com",
        ];
        let host: string;
        try { host = new URL(input.url).hostname; } catch { throw new TRPCError({ code: "BAD_REQUEST", message: "כתובת URL לא תקינה" }); }
        if (!ALLOWED_HOSTS.includes(host)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "רק קישורי YouTube נתמכים" });
        }
        const jobId = await createYouTubeJob(
          input.url,
          input.cookiesKey,
          undefined,
          input.sourceLang ?? "auto",
          input.targetLang ?? "he",
          input.subtitlePosition ?? "bottom",
        );
        return { jobId };
      }),

    uploadCookies: t.procedure
      .input(z.object({ content: z.string() }))
      .mutation(async ({ input }) => {
        const buf = Buffer.from(input.content, "base64");
        const key = `cookies/cookies-${nanoid()}.txt`;
        await gcsUpload(key, buf, "text/plain");
        return { key };
      }),

    getDownloadUrl: t.procedure
      .input(z.object({ id: z.string() }))
      .query(async ({ input }) => {
        const job = await getJobById(input.id);
        if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "עבודה לא נמצאה" });
        if (job.status !== "completed" || !job.outputKey) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "הסרטון עדיין לא מוכן" });
        }
        return { url: `/api/download/${input.id}` };
      }),

    getSrtUrl: t.procedure
      .input(z.object({ id: z.string() }))
      .query(async ({ input }) => {
        const job = await getJobById(input.id);
        if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "עבודה לא נמצאה" });
        if (job.status !== "completed" || !job.srtKey) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "קובץ הכתוביות עדיין לא מוכן" });
        }
        return { url: `/api/download-srt/${input.id}` };
      }),

    prepareCookieCapture: t.procedure
      .input(z.object({ url: z.string().url() }))
      .mutation(async ({ input }) => {
        const token = createCapture(input.url);
        return { token };
      }),

    getCaptureStatus: t.procedure
      .input(z.object({ token: z.string() }))
      .query(async ({ input }) => {
        const entry = getCapture(input.token);
        if (!entry) return { received: false, jobId: null, expired: true };
        return { received: !!entry.jobId, jobId: entry.jobId ?? null, expired: false };
      }),

    youTubeCookiesStatus: t.procedure.query(async () => {
      const connected = await globalCookiesExist();
      return { connected };
    }),

    prepareYouTubeConnect: t.procedure.mutation(async () => {
      const token = createSetupCapture();
      return { token };
    }),

    getConnectStatus: t.procedure
      .input(z.object({ token: z.string() }))
      .query(async ({ input }) => {
        return { done: isSetupComplete(input.token) };
      }),

    disconnectYouTube: t.procedure.mutation(async () => {
      await deleteGlobalCookies();
      return { ok: true };
    }),
  }),
});

export type AppRouter = typeof appRouter;
