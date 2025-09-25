import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "../db/schema.js";
import { eq } from "drizzle-orm";

type DatabaseClient = PgliteDatabase<typeof schema>;

export type ScheduleBlock =
  (typeof schema.scheduleBlockEnum.enumValues)[number];

export const SECONDS_PER_BLOCK = 25;
export const BLOCKS_PER_DAY = 24; // 24 blocks x 25s = 10 minutes
export const SECONDS_PER_DAY = SECONDS_PER_BLOCK * BLOCKS_PER_DAY; // 600

/** Canonical flag id for a schedule block (snake_case slugs). */
export function scheduleFlag(block: ScheduleBlock): string {
  // Use snake_case to satisfy config slug schema
  return `schedule_block_${block}`;
}

/**
 * Computes the 0..23 schedule index for a given timestamp, with optional offset.
 * Normalizes negatives into the same 0..599 second window.
 */
export function computeBlockIndex(at: Date, offsetSeconds = 0): number {
  const t = Math.floor(at.getTime() / 1000) + offsetSeconds;
  const within = ((t % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY; // normalize
  return Math.floor(within / SECONDS_PER_BLOCK) % BLOCKS_PER_DAY;
}

/** Resolve a schedule block from an in-memory blocks array at a given time. */
export function resolveScheduleBlockFromBlocks(
  blocks: unknown,
  at: Date,
): ScheduleBlock | null {
  if (!Array.isArray(blocks)) return null;
  const idx = computeBlockIndex(at);
  const value = blocks[idx];
  if (
    value === "bathtime" ||
    value === "work" ||
    value === "downtime" ||
    value === "bedtime"
  ) {
    return value;
  }
  return null;
}

/** Loads the tav’s schedule and returns the active block at `at` (or null). */
export async function getCurrentScheduleBlock(
  db: DatabaseClient,
  tavId: number,
  at: Date,
): Promise<ScheduleBlock | null> {
  const row = await db.query.tav.findFirst({
    where: eq(schema.tav.id, tavId),
    columns: { scheduleId: true },
    with: { schedule: { columns: { id: true, blocks: true } } },
  });

  const blocks = (row as any)?.schedule?.blocks as unknown;
  return resolveScheduleBlockFromBlocks(blocks, at);
}
