import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import * as schema from "../db/schema.js";
import { DEFAULT_SCHEDULE_BLOCKS } from "../config.js";
import { createTav } from "./tav.js";
import { computeBlockIndex, getCurrentScheduleBlock, resolveScheduleBlockFromBlocks } from "./schedule.js";

type DatabaseClient = PgliteDatabase<typeof schema>;

function migrationsPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return join(currentDir, "../../drizzle");
}

describe("schedule", () => {
  let client: PGlite;
  let db: DatabaseClient;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle({ client, schema });
    await migrate(db, { migrationsFolder: migrationsPath() });
  });

  afterEach(async () => {
    await client.close();
  });

  it("computes block index over a 600s cycle", () => {
    const at0 = new Date(0);
    expect(computeBlockIndex(at0)).toBe(0);

    // 25s per block
    expect(computeBlockIndex(new Date(24_999))).toBe(0);
    expect(computeBlockIndex(new Date(25_000))).toBe(1);
    expect(computeBlockIndex(new Date(599_999))).toBe(23);
    expect(computeBlockIndex(new Date(600_000))).toBe(0);
  });

  it("returns current schedule block for a tav", async () => {
    // Create a schedule with a distinct first block
    const blocks = Array.from({ length: 24 }, (_, i) => (i === 0 ? "work" : "downtime"));
    const [sched] = await db
      .insert(schema.schedule)
      .values({ name: "default", description: "", blocks })
      .returning();

    const [t] = await db
      .insert(schema.tav)
      .values({
        name: "WithSchedule",
        abilityScores: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
        flags: [],
        scheduleId: sched.id,
      })
      .returning();

    const at0 = new Date(0);
    const block0 = await getCurrentScheduleBlock(db, t.id, at0);
    expect(block0).toBe("work");

    const atSecondBlock = new Date(25_000);
    const block1 = await getCurrentScheduleBlock(db, t.id, atSecondBlock);
    expect(block1).toBe("downtime");
  });

  it("auto-assigns the configured default schedule when creating a tav", async () => {
    const t = await createTav(db as unknown as DatabaseClient, { name: "AutoSchedule" });

    const [row] = await db
      .select()
      .from(schema.tav)
      .where(eq(schema.tav.id, t.id));

    expect(row.scheduleId).toBeTruthy();

    const [sched] = await db
      .select()
      .from(schema.schedule)
      .where(eq(schema.schedule.id, row.scheduleId!));

    expect(sched.blocks).toEqual(DEFAULT_SCHEDULE_BLOCKS);
  });

  it("resolves block from in-memory blocks array and returns null for invalid entries", () => {
    const blocks = [
      "work",
      "downtime",
      "bathtime",
      "bedtime",
      "work",
      "work",
      // rest default to work for simplicity
      ...Array.from({ length: 18 }, () => "work"),
    ];

    expect(resolveScheduleBlockFromBlocks(blocks, new Date(0))).toBe("work");
    expect(resolveScheduleBlockFromBlocks(blocks, new Date(25_000))).toBe(
      "downtime",
    );
    expect(resolveScheduleBlockFromBlocks(blocks, new Date(50_000))).toBe(
      "bathtime",
    );
    expect(resolveScheduleBlockFromBlocks(blocks, new Date(75_000))).toBe(
      "bedtime",
    );

    const invalid = [
      "work",
      // inject an invalid string at index 1
      "partytime" as any,
      ...Array.from({ length: 22 }, () => "work"),
    ];
    expect(resolveScheduleBlockFromBlocks(invalid, new Date(25_000))).toBe(
      null,
    );
  });
});
