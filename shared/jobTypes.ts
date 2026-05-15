export const JOB_STATUS = [
  "pending",
  "uploading",
  "transcribing",
  "translating",
  "embedding",
  "completed",
  "failed",
] as const;

export type JobStatus = (typeof JOB_STATUS)[number];
