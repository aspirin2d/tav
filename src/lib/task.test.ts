import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
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

const { task, tav: tavTable, skill, inventory } = schema;

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

  // Higher-priority work should pre-empt lower-priority options.
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
      { tavId: tav.id, skillId: "logging", targetId: "small_tree" },
    ]);
  });

  // No state changes when nothing is queued.
  it("returns immediately when no tav requires work", async () => {
    const outcome = await tickTask(db, { now: new Date(0) });
    expect(outcome.started).toHaveLength(0);
    expect(outcome.completed).toHaveLength(0);
    expect(outcome.failed).toHaveLength(0);
  });

  // Missing timestamps fall back to Date.now().
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

  // Running tasks are left alone until their deadline expires.
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

  // Expired executions should recycle and immediately start fresh work.
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

  // Completion effects update XP and inventory alongside status transitions.
  it("applies completion rewards when recycling finished work", async () => {
    const tav = await createTav(db, { name: "Rewarded" });

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

    await tickTask(db, {
      tavId: tav.id,
      now: new Date(5000),
      context: { customChecks: { logging_allowed: true } },
    });

    const [tavRow] = await db
      .select({ xp: tavTable.xp })
      .from(tavTable)
      .where(eq(tavTable.id, tav.id));

    expect(tavRow?.xp).toBe(3);

    const [skillRow] = await db
      .select({ xp: skill.xp })
      .from(skill)
      .where(
        and(eq(skill.tavId, tav.id), eq(skill.id, "logging")),
      );

    expect(skillRow?.xp).toBe(10);

    const inventoryRows = await db
      .select()
      .from(inventory)
      .where(eq(inventory.tavId, tav.id));

    expect(inventoryRows).toContainEqual(
      expect.objectContaining({ itemId: "log", qty: 1 }),
    );
  });

  // Logging twice feeds crafting once, respecting priority and resource costs.
  it("chains skills so gathering feeds crafting output", async () => {
    const tav = await createTav(db, { name: "Crafter" });

    await db
      .update(tavTable)
      .set({ flags: ["forest_access", "sawmill_ready"] })
      .where(eq(tavTable.id, tav.id));

    await db.insert(skill).values({ tavId: tav.id, id: "logging", xpLevel: 3 });

    await addTask(db, {
      tavId: tav.id,
      skillId: "logging",
      targetId: "small_tree",
    });

    await addTask(db, {
      tavId: tav.id,
      skillId: "wood_craft",
      targetId: "plank",
    });

    let outcome = await tickTask(db, {
      tavId: tav.id,
      now: new Date(0),
      context: { customChecks: { logging_allowed: true } },
    });

    expect(outcome.started).toEqual([
      { tavId: tav.id, skillId: "logging", targetId: "small_tree" },
    ]);

    outcome = await tickTask(db, {
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

    outcome = await tickTask(db, {
      tavId: tav.id,
      now: new Date(10000),
      context: { customChecks: { logging_allowed: true } },
    });

    expect(outcome.completed).toEqual([
      { tavId: tav.id, skillId: "logging", targetId: "small_tree" },
    ]);
    expect(outcome.started).toEqual([
      { tavId: tav.id, skillId: "wood_craft", targetId: "plank" },
    ]);

    outcome = await tickTask(db, {
      tavId: tav.id,
      now: new Date(15000),
      context: { customChecks: { logging_allowed: true } },
    });

    expect(outcome.completed).toEqual([
      { tavId: tav.id, skillId: "wood_craft", targetId: "plank" },
    ]);
    expect(outcome.started).toEqual([
      { tavId: tav.id, skillId: "logging", targetId: "small_tree" },
    ]);

    const items = await db
      .select({ itemId: inventory.itemId, qty: inventory.qty })
      .from(inventory)
      .where(eq(inventory.tavId, tav.id));

    expect(items).toContainEqual(
      expect.objectContaining({ itemId: "plank", qty: 1 }),
    );
    expect(items.find((item) => item.itemId === "log")).toBeUndefined();
  });

  // Requirement failures should keep tasks in the queue untouched.
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

  // Unknown skill ids should mark running tasks as failed.
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

  // Validation errors are treated like unmet requirements.
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
