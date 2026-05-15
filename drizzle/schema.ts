import {
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
  float,
} from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

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

export const jobs = mysqlTable("jobs", {
  id: varchar("id", { length: 36 }).primaryKey(),
  userId: int("userId").references(() => users.id),
  status: mysqlEnum("status", JOB_STATUS).default("pending").notNull(),
  inputType: mysqlEnum("inputType", ["file", "youtube"]).notNull(),
  inputUrl: text("inputUrl"),
  inputKey: text("inputKey"),
  localPath: text("localPath"),
  originalFilename: text("originalFilename"),
  outputKey: text("outputKey"),
  outputUrl: text("outputUrl"),
  errorMessage: text("errorMessage"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Job = typeof jobs.$inferSelect;
export type InsertJob = typeof jobs.$inferInsert;

export const jobSegments = mysqlTable("job_segments", {
  id: int("id").autoincrement().primaryKey(),
  jobId: varchar("jobId", { length: 36 })
    .notNull()
    .references(() => jobs.id),
  segmentIndex: int("segmentIndex").notNull(),
  startTime: float("startTime").notNull(),
  endTime: float("endTime").notNull(),
  originalText: text("originalText"),
  translatedText: text("translatedText"),
});

export type JobSegment = typeof jobSegments.$inferSelect;
export type InsertJobSegment = typeof jobSegments.$inferInsert;
