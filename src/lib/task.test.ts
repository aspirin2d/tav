import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { tickTask } from "./task.js";
import {
  addTask,
  createTav,
} from "../db/tav.js";
import * as schema from "../db/schema.js";

const { task, tav: tavTable, skill } = schema;

type DatabaseClient = PgliteDatabase<typeof schema>;

function migrationsPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return join(currentDir, "../../drizzle");
}

describe("task ticking", () => {
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

  it("selects the highest priority executable pending task", async () => {
    const tav = await createTav(db, { name: "Priority" });

    await db
      .update(tavTable)
      .set({ flags: ["forest_access", "scout_ready"] })
      .where(eq(tavTable.id, tav.id));

    await addTask(db, {
      tavId: tav.id,
      skillId: "logging",
      targetId: "small_tree",
    });

    await addTask(db, {
      tavId: tav.id,
      skillId: "survey",
      targetId: "forest_edge",
    });

    const result = await tickTask(db, {
      tavId: tav.id,
      now: new Date(0),
      context: {
        customChecks: { logging_allowed: true },
        inventory: { torch: 1 },
      },
    });

    expect(result.started).toEqual([
      { tavId: tav.id, skillId: "survey", targetId: "forest_edge" },
    ]);
  });

  it("returns immediately when no tav requires work", async () => {
    const outcome = await tickTask(db, { now: new Date(0) });
    expect(outcome.started).toHaveLength(0);
    expect(outcome.completed).toHaveLength(0);
    expect(outcome.failed).toHaveLength(0);
  });

  it("uses the current time when now is omitted", async () => {
    const tav = await createTav(db, { name: "DefaultClock" });

    await addTask(db, {
      tavId: tav.id,
      skillId: "idle",
      targetId: null,
    });

    const outcome = await tickTask(db, { tavId: tav.id });
    expect(outcome.started).toEqual([
      { tavId: tav.id, skillId: "idle", targetId: schema.TASK_TARGETLESS_KEY },
    ]);
  });

  it("does nothing when a task is still running", async () => {
    const tav = await createTav(db, { name: "Runner" });

    await db
      .update(tavTable)
      .set({ flags: ["forest_access"] })
      .where(eq(tavTable.id, tav.id));

    await addTask(db, {
      tavId: tav.id,
      skillId: "logging",
      targetId: "small_tree",
    });

    await tickTask(db, {
      tavId: tav.id,
      now: new Date(0),
      context: { customChecks: { logging_allowed: true } },
    });

    const result = await tickTask(db, {
      tavId: tav.id,
      now: new Date(1000),
      context: { customChecks: { logging_allowed: true } },
    });

    expect(result.started).toHaveLength(0);
    expect(result.completed).toHaveLength(0);

    const [row] = await db
      .select()
      .from(task)
      .where(eq(task.tavId, tav.id));
    expect(row.status).toBe("executing");
  });

  it("completes overdue work then starts the next pending task", async () => {
    const tav = await createTav(db, { name: "Finisher" });

    await db
      .update(tavTable)
      .set({ flags: ["forest_access"] })
      .where(eq(tavTable.id, tav.id));

    await addTask(db, {
      tavId: tav.id,
      skillId: "logging",
      targetId: "small_tree",
    });

    await addTask(db, {
      tavId: tav.id,
      skillId: "idle",
      targetId: null,
    });

    await tickTask(db, {
      tavId: tav.id,
      now: new Date(0),
      context: { customChecks: { logging_allowed: true } },
    });

    const outcome = await tickTask(db, {
      tavId: tav.id,
      now: new Date(5000),
      context: { customChecks: { logging_allowed: true } },
    });

    expect(outcome.completed).toEqual([
      { tavId: tav.id, skillId: "logging", targetId: "small_tree" },
    ]);
    expect(outcome.started).toEqual([
      { tavId: tav.id, skillId: "logging", targetId: "small_tree" },
    ]);
  });

  it("skips pending tasks when requirements fail", async () => {
    const tav = await createTav(db, { name: "Blocked" });

    await db
      .update(tavTable)
      .set({ flags: ["forest_access"] })
      .where(eq(tavTable.id, tav.id));

    await addTask(db, {
      tavId: tav.id,
      skillId: "logging",
      targetId: "small_tree",
    });

    const outcome = await tickTask(db, {
      tavId: tav.id,
      now: new Date(0),
      context: { customChecks: { logging_allowed: false } },
    });

    expect(outcome.started).toHaveLength(0);
  });

  it("fails executing tasks with unknown skills", async () => {
    const tav = await createTav(db, { name: "Mystery" });

    await db.insert(skill).values({ id: "unknown", tavId: tav.id });

    await db.insert(task).values({
      tavId: tav.id,
      skillId: "unknown",
      targetId: schema.TASK_TARGETLESS_KEY,
      status: "executing",
      startedAt: new Date(0),
    });

    const outcome = await tickTask(db, {
      tavId: tav.id,
      now: new Date(1000),
    });

    expect(outcome.failed).toEqual([
      { tavId: tav.id, skillId: "unknown", targetId: schema.TASK_TARGETLESS_KEY },
    ]);
  });

  it("ignores pending tasks that throw during validation", async () => {
    const tav = await createTav(db, { name: "Validator" });

    await db.insert(skill).values({ id: "logging", tavId: tav.id });
    await db
      .insert(task)
      .values({
        tavId: tav.id,
        skillId: "logging",
        targetId: "mystery_target",
        status: "pending",
        createdAt: new Date(0),
      });

    const outcome = await tickTask(db, {
      tavId: tav.id,
      now: new Date(5000),
      context: { customChecks: { logging_allowed: true } },
    });

    expect(outcome.started).toHaveLength(0);
    expect(outcome.completed).toHaveLength(0);
    expect(outcome.failed).toHaveLength(0);
  });

  it("ignores pending tasks with unknown skill definitions", async () => {
    const tav = await createTav(db, { name: "UnknownSkill" });

    await db.insert(skill).values({ id: "orphan", tavId: tav.id });
    await db
      .insert(task)
      .values({
        tavId: tav.id,
        skillId: "orphan",
        targetId: schema.TASK_TARGETLESS_KEY,
        status: "pending",
      });

    const outcome = await tickTask(db, { tavId: tav.id, now: new Date(0) });
    expect(outcome.started).toHaveLength(0);
  });

  it("falls back to the first active tav when none is supplied", async () => {
    const tav = await createTav(db, { name: "Fallback" });

    await addTask(db, {
      tavId: tav.id,
      skillId: "idle",
      targetId: null,
    });

    const outcome = await tickTask(db, {
      now: new Date(0),
    });

    expect(outcome.started).toEqual([
      { tavId: tav.id, skillId: "idle", targetId: schema.TASK_TARGETLESS_KEY },
    ]);
  });

  it("updates the tav's last tick timestamp", async () => {
    const tav = await createTav(db, { name: "Clock" });

    await addTask(db, {
      tavId: tav.id,
      skillId: "idle",
      targetId: null,
    });

    await tickTask(db, { tavId: tav.id, now: new Date(1234) });

    const [row] = await db
      .select({ updatedAt: tavTable.updatedAt })
      .from(tavTable)
      .where(eq(tavTable.id, tav.id));

    expect(row.updatedAt?.getTime()).toBe(1234);
  });

  it("treats missing startedAt as an immediate start", async () => {
    const tav = await createTav(db, { name: "MissingStart" });

    await db.insert(skill).values({ id: "logging", tavId: tav.id });

    await db
      .insert(task)
      .values({
        tavId: tav.id,
        skillId: "logging",
        targetId: "small_tree",
        status: "executing",
        startedAt: null,
      });

    const outcome = await tickTask(db, {
      tavId: tav.id,
      now: new Date(1000),
      lastTickAt: new Date(0),
      context: { customChecks: { logging_allowed: true } },
    });

    expect(outcome.started).toHaveLength(0);
    expect(outcome.completed).toHaveLength(0);
  });

  it("falls back to the current time when a tav row is missing", async () => {
    const outcome = await tickTask(db, { tavId: 9999 });
    expect(outcome.started).toHaveLength(0);
    expect(outcome.completed).toHaveLength(0);
    expect(outcome.failed).toHaveLength(0);
  });
});
