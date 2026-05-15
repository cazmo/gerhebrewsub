import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { getJobById, listJobs } from "./db";
import { storagePut } from "./storage";
import { createFileJob, createYouTubeJob } from "./pipeline";
import { nanoid } from "nanoid";

export const appRouter = router({
  system: systemRouter,

  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  jobs: router({
    /** Get a single job by ID */
    get: publicProcedure
      .input(z.object({ id: z.string() }))
      .query(async ({ input }) => {
        const job = await getJobById(input.id);
        if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "עבודה לא נמצאה" });
        return job;
      }),

    /** List last 50 jobs (filtered by user if authenticated) */
    list: publicProcedure.query(async ({ ctx }) => {
      const userId = ctx.user?.id;
      return listJobs(userId);
    }),

    /** Start a job from an already-uploaded file key */
    startFromFile: publicProcedure
      .input(
        z.object({
          fileKey: z.string(),
          originalFilename: z.string(),
          localPath: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const jobId = await createFileJob(
          input.fileKey,
          input.originalFilename,
          ctx.user?.id,
          input.localPath
        );
        return { jobId };
      }),

    /** Start a job from a YouTube URL */
    startFromYouTube: publicProcedure
      .input(
        z.object({
          url: z.string().url(),
          cookiesKey: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const jobId = await createYouTubeJob(
          input.url,
          input.cookiesKey,
          ctx.user?.id
        );
        return { jobId };
      }),

    /** Upload cookies.txt content (base64) and return storage key */
    uploadCookies: publicProcedure
      .input(z.object({ content: z.string() }))
      .mutation(async ({ input }) => {
        const buf = Buffer.from(input.content, "base64");
        const key = `cookies/cookies-${nanoid()}.txt`;
        await storagePut(key, buf, "text/plain");
        return { key };
      }),

    /** Get a download URL for the completed job output */
    getDownloadUrl: publicProcedure
      .input(z.object({ id: z.string() }))
      .query(async ({ input }) => {
        const job = await getJobById(input.id);
        if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "עבודה לא נמצאה" });
        if (job.status !== "completed" || !job.outputKey) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "הסרטון עדיין לא מוכן" });
        }
        const filename = encodeURIComponent(
          `video-hebrew-${input.id.slice(0, 8)}.mp4`
        );
        // Use /manus-download/ proxy — NOT a direct signed S3 URL
        const url = `/manus-download/${job.outputKey}?filename=${filename}`;
        return { url };
      }),
  }),
});

export type AppRouter = typeof appRouter;
