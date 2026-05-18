# מתרגם כתוביות גרמנית→עברית

A German-to-Hebrew subtitle translator. Upload a video file or provide a YouTube URL; the app transcribes the German audio with OpenAI Whisper, translates to Hebrew with GPT-4.1-mini, embeds the subtitles into the video, and lets users download the result.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/gerhebrewsub run dev` — run the frontend (port 21837)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required env: `DEFAULT_OBJECT_STORAGE_BUCKET_ID` — GCS object storage bucket (Replit App Storage)
- Required env: `AI_INTEGRATIONS_OPENAI_BASE_URL`, `AI_INTEGRATIONS_OPENAI_API_KEY` — Replit AI integration for OpenAI

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 + tRPC (NOT OpenAPI/REST)
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod, drizzle-zod
- Build: esbuild (CJS bundle)
- Frontend: React + Vite + Tailwind v4 + wouter + sonner (RTL Hebrew UI)
- Storage: Replit App Storage (GCS-backed via `@google-cloud/storage`)

## Where things live

- `artifacts/api-server/src/` — Express + tRPC server
  - `trpcRouter.ts` — tRPC router (source of truth for API contract)
  - `pipeline.ts` — main processing pipeline (download → transcribe → translate → embed)
  - `db.ts` — DB helpers
  - `gcsHelper.ts` — Google Cloud Storage wrapper
  - `captureStore.ts` — in-memory token store for cookie relay
- `artifacts/gerhebrewsub/src/` — React frontend
  - `lib/trpc.ts` — tRPC client setup
  - `pages/Home.tsx` — upload form (file or YouTube URL)
  - `pages/JobStatus.tsx` — real-time job progress
  - `pages/History.tsx` — job list
- `lib/db/src/schema/jobs.ts` — DB schema (jobs + jobSegments tables)
- `bin/yt-dlp` — yt-dlp binary for YouTube downloads

## Architecture decisions

- tRPC instead of OpenAPI — the app was migrated from GitHub using tRPC; the frontend imports `AppRouter` type directly from the API server via a cross-package relative path, enabled by `fs.strict: false` in Vite config.
- Chunked upload — large files (up to 500MB) are split into 5MB chunks sent to `/api/upload/chunk`, assembled server-side, then processed locally (never goes to GCS for the source file).
- Local temp-file pipeline — video files are processed in a temp directory via ffmpeg/yt-dlp; only the final output video is uploaded to GCS.
- YouTube cookie relay — users can paste Netscape-format cookies to bypass bot detection.

## Product

- Upload a video file (MP4, MOV, AVI, WebM, MKV up to 500MB) or paste a YouTube URL
- The server transcribes audio with Whisper (`whisper-1` — returns per-segment timestamps via verbose_json), translates with GPT-4.1-mini, burns the subtitles in with ffmpeg, and uploads the result to GCS
- The user can download the output MP4 from the job status page or history page

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- **Cross-artifact tRPC import**: `artifacts/gerhebrewsub/src/lib/trpc.ts` imports `AppRouter` from `../../../../artifacts/api-server/src/trpcRouter`. This requires `fs.strict: false` in Vite config.
- **yt-dlp binary** at `bin/yt-dlp` — must be executable (`chmod +x`). Path overrideable via `YT_DLP_PATH` env var.
- **OpenAI env vars**: pipeline.ts requires both `AI_INTEGRATIONS_OPENAI_API_KEY` and `AI_INTEGRATIONS_OPENAI_BASE_URL` to be set (via `setupReplitAIIntegrations`).
- **Object storage**: `DEFAULT_OBJECT_STORAGE_BUCKET_ID` must be set (via `setupObjectStorage()`).
- The `@workspace/api-zod` package is NOT used — this app uses tRPC, not the generated OpenAPI client.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
