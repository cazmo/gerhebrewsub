import { eq, desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, users, jobs, jobSegments, Job, InsertJob, JobSegment, InsertJobSegment } from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) return;

  const values: InsertUser = { openId: user.openId };
  const updateSet: Record<string, unknown> = {};

  const textFields = ["name", "email", "loginMethod"] as const;
  type TextField = (typeof textFields)[number];
  const assignNullable = (field: TextField) => {
    const value = user[field];
    if (value === undefined) return;
    const normalized = value ?? null;
    values[field] = normalized;
    updateSet[field] = normalized;
  };
  textFields.forEach(assignNullable);

  if (user.lastSignedIn !== undefined) {
    values.lastSignedIn = user.lastSignedIn;
    updateSet.lastSignedIn = user.lastSignedIn;
  }
  if (user.role !== undefined) {
    values.role = user.role;
    updateSet.role = user.role;
  } else if (user.openId === ENV.ownerOpenId) {
    values.role = "admin";
    updateSet.role = "admin";
  }
  if (!values.lastSignedIn) values.lastSignedIn = new Date();
  if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();

  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// ── Jobs ──────────────────────────────────────────────────────────────────────

export async function createJob(data: InsertJob): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.insert(jobs).values(data);
}

export async function getJobById(id: string): Promise<Job | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return result[0];
}

export async function updateJob(id: string, data: Partial<InsertJob>): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(jobs).set(data).where(eq(jobs.id, id));
}

export async function listJobs(userId?: number): Promise<Job[]> {
  const db = await getDb();
  if (!db) return [];
  if (userId !== undefined) {
    return db.select().from(jobs).where(eq(jobs.userId, userId)).orderBy(desc(jobs.createdAt)).limit(50);
  }
  return db.select().from(jobs).orderBy(desc(jobs.createdAt)).limit(50);
}

// ── Job Segments ──────────────────────────────────────────────────────────────

export async function insertSegments(segments: InsertJobSegment[]): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  if (segments.length === 0) return;
  await db.insert(jobSegments).values(segments);
}

export async function getSegmentsByJobId(jobId: string): Promise<JobSegment[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(jobSegments).where(eq(jobSegments.jobId, jobId));
}
