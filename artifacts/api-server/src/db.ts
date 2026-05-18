import { eq, desc } from "drizzle-orm";
import { db } from "@workspace/db";
import { jobs, jobSegments } from "@workspace/db";
import type { InsertJob, InsertJobSegment, Job, JobSegment } from "@workspace/db";

export async function createJob(data: InsertJob): Promise<void> {
  await db.insert(jobs).values(data);
}

export async function getJobById(id: string): Promise<Job | undefined> {
  const result = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return result[0];
}

export async function updateJob(id: string, data: Partial<InsertJob>): Promise<void> {
  await db.update(jobs).set({ ...data, updatedAt: new Date() }).where(eq(jobs.id, id));
}

export async function listJobs(userId?: number): Promise<Job[]> {
  if (userId !== undefined) {
    return db.select().from(jobs).where(eq(jobs.userId, userId)).orderBy(desc(jobs.createdAt)).limit(50);
  }
  return db.select().from(jobs).orderBy(desc(jobs.createdAt)).limit(50);
}

export async function insertSegments(segments: InsertJobSegment[]): Promise<void> {
  if (segments.length === 0) return;
  await db.insert(jobSegments).values(segments);
}

export async function getSegmentsByJobId(jobId: string): Promise<JobSegment[]> {
  return db.select().from(jobSegments).where(eq(jobSegments.jobId, jobId));
}
