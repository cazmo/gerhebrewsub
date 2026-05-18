import { pgTable, serial, varchar, text, integer, real, timestamp, pgEnum, boolean } from "drizzle-orm/pg-core";

export const jobStatusEnum = pgEnum("job_status", [
  "pending", "uploading", "transcribing", "translating", "embedding", "completed", "failed",
]);

export const inputTypeEnum = pgEnum("input_type", ["file", "youtube"]);

export const jobs = pgTable("jobs", {
  id: varchar("id", { length: 36 }).primaryKey(),
  userId: integer("user_id"),
  status: jobStatusEnum("status").default("pending").notNull(),
  inputType: inputTypeEnum("input_type").notNull(),
  inputUrl: text("input_url"),
  inputKey: text("input_key"),
  localPath: text("local_path"),
  originalFilename: text("original_filename"),
  outputKey: text("output_key"),
  outputUrl: text("output_url"),
  errorMessage: text("error_message"),
  failedAtStatus: jobStatusEnum("failed_at_status"),
  sourceLang: varchar("source_lang", { length: 10 }).default("auto").notNull(),
  targetLang: varchar("target_lang", { length: 10 }).default("he").notNull(),
  hasBurnedInSubs: boolean("has_burned_in_subs").default(false),
  srtKey: text("srt_key"),
  subtitlePosition: varchar("subtitle_position", { length: 10 }).default("bottom").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const jobSegments = pgTable("job_segments", {
  id: serial("id").primaryKey(),
  jobId: varchar("job_id", { length: 36 }).notNull().references(() => jobs.id),
  segmentIndex: integer("segment_index").notNull(),
  startTime: real("start_time").notNull(),
  endTime: real("end_time").notNull(),
  originalText: text("original_text"),
  translatedText: text("translated_text"),
});

export type InsertJob = typeof jobs.$inferInsert;
export type InsertJobSegment = typeof jobSegments.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type JobSegment = typeof jobSegments.$inferSelect;
