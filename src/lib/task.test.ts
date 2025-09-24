import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { tickTask } from "./task.js";
import { addTask, createTav } from "./tav.js";
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

  it("ignores pending tasks with an unknown skill", async () => {
    const tav = await createTav(db, { name: "UnknownSkillPending" });

    // Satisfy FK: create a skill row that doesn't exist in config
    await db.insert(skill).values({ tavId: tav.id, id: "mystery" });

    await db.insert(task).values({
      tavId: tav.id,
      skillId: "mystery",
      targetId: schema.TASK_TARGETLESS_KEY,
      status: "pending",
    });

    const outcome = await tickTask(db, {
      tavId: tav.id,
      lastTickAt: new Date(0),
      now: new Date(1000),
    });

    expect(outcome.started).toHaveLength(0);
    expect(outcome.completed).toHaveLength(0);
    expect(outcome.failed).toHaveLength(0);
  });

  it("throws when the executing task references an unknown skill", async () => {
    const tav = await createTav(db, { name: "UnknownSkillExecuting" });

    // Satisfy FK: create a skill row that doesn't exist in config
    await db.insert(skill).values({ tavId: tav.id, id: "ghost" });

    await db.insert(task).values({
      tavId: tav.id,
      skillId: "ghost",
      targetId: schema.TASK_TARGETLESS_KEY,
      status: "executing",
      startedAt: new Date(0),
    });

    await expect(
      tickTask(db, {
        tavId: tav.id,
        lastTickAt: new Date(0),
        now: new Date(3000),
      }),
    ).rejects.toThrow(/skill not found: ghost/);
  });

  it("throws when a pending task targets a disallowed id", async () => {
    const tav = await createTav(db, { name: "DisallowedTarget" });

    // Satisfy FK
    await db.insert(skill).values({ tavId: tav.id, id: "logging" });

    // Insert an impossible target for logging
    await db.insert(task).values({
      tavId: tav.id,
      skillId: "logging",
      targetId: "invalid_target",
      status: "pending",
    });

    await expect(
      tickTask(db, {
        tavId: tav.id,
        lastTickAt: new Date(0),
        now: new Date(10),
      }),
    ).rejects.toThrow(/skill logging cannot target id: invalid_target/);
  });

  it("prefers older createdAt when priorities tie", async () => {
    const tav = await createTav(db, { name: "TieBreaker" });

    // Enable both idle and logging as executable with equal priority (5)
    await db
      .update(tavTable)
      .set({ flags: ["forest_access"] })
      .where(eq(tavTable.id, tav.id));

    // Insert older task first (idle)
    await addTask(db, {
      tavId: tav.id,
      skillId: "idle",
      targetId: null,
    });

    // Slightly newer pending task (logging)
    await addTask(db, {
      tavId: tav.id,
      skillId: "logging",
      targetId: "small_tree",
    });

    const result = await tickTask(db, {
      tavId: tav.id,
      lastTickAt: new Date(0),
      now: new Date(100),
      context: { customChecks: { logging_allowed: true } },
    });

    expect(result.started[0]).toEqual({
      tavId: tav.id,
      skillId: "idle",
      targetId: schema.TASK_TARGETLESS_KEY,
    });
  });

  it("leaves ineligible pending tasks untouched when requirements are unmet", async () => {
    const tav = await createTav(db, { name: "UnmetRequirements" });

    // Use a skill/target pair with no add requirements but with execute requirements
    await addTask(db, {
      tavId: tav.id,
      skillId: "survey",
      targetId: "forest_edge",
    });

    const outcome = await tickTask(db, {
      tavId: tav.id,
      lastTickAt: new Date(0),
      now: new Date(5000),
      // No forest_access flag and no torch in inventory; execute should be ineligible
    });

    expect(outcome.started).toHaveLength(0);
    expect(outcome.completed).toHaveLength(0);
  });

  it("can start a craft using inventory provided via context only", async () => {
    const tav = await createTav(db, { name: "ContextInventory" });

    await db
      .update(tavTable)
      .set({ flags: ["sawmill_ready"] })
      .where(eq(tavTable.id, tav.id));

    // Meet add requirements: logging level >= 2
    await db.insert(skill).values({ tavId: tav.id, id: "logging", xpLevel: 3 });

    await addTask(db, {
      tavId: tav.id,
      skillId: "wood_craft",
      targetId: "plank",
    });

    // No logs in DB; provide virtually via context
    const outcome = await tickTask(db, {
      tavId: tav.id,
      lastTickAt: new Date(0),
      now: new Date(10),
      context: { inventory: { log: 2 } },
    });

    expect(outcome.started).toEqual([
      { tavId: tav.id, skillId: "wood_craft", targetId: "plank" },
    ]);
  });

  it("auto-selects the tav when tavId is omitted", async () => {
    const tav = await createTav(db, { name: "AutoPick" });

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
      lastTickAt: new Date(0),
      now: new Date(2000),
      context: { customChecks: { logging_allowed: true } },
    });

    expect(outcome.started.length).toBeGreaterThanOrEqual(1);
    expect(outcome.started[0]).toEqual({
      tavId: tav.id,
      skillId: "logging",
      targetId: "small_tree",
    });
  });

  it("breaks cleanly when there are pending but ineligible tasks", async () => {
    const tav = await createTav(db, { name: "NoEligible" });

    // Allow adding the task (target add requirement)
    await db
      .update(tavTable)
      .set({ flags: ["forest_access"] })
      .where(eq(tavTable.id, tav.id));

    await addTask(db, {
      tavId: tav.id,
      skillId: "logging",
      targetId: "small_tree",
    });

    // Do not provide the custom execute flag logging_allowed → ineligible
    const outcome = await tickTask(db, { tavId: tav.id, now: new Date(0) });

    expect(outcome.started).toHaveLength(0);
    expect(outcome.completed).toHaveLength(0);

    const [row] = await db.select().from(task).where(eq(task.tavId, tav.id));
    expect(row.status).toBe("pending");
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
      lastTickAt: new Date(0),
      now: new Date(100),
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
    const tav = await createTav(db, { name: "Priority" });
    const outcome = await tickTask(db, { now: new Date(0), tavId: tav.id });
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

    const result = await tickTask(db, {
      tavId: tav.id,
      lastTickAt: new Date(0),
      now: new Date(1000),
      context: { customChecks: { logging_allowed: true } },
    });

    expect(result.started).toHaveLength(1);
    expect(result.completed).toHaveLength(0);

    const [row] = await db.select().from(task).where(eq(task.tavId, tav.id));
    expect(row.status).toBe("executing");
  });

  it("completes the executing task first then starts the next pending task", async () => {
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
      lastTickAt: new Date(0),
      now: new Date(3000),
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
      lastTickAt: new Date(0),
      now: new Date(5000),
      context: { customChecks: { logging_allowed: true } },
    });

    const [tavRow] = await db
      .select({ xp: tavTable.xp })
      .from(tavTable)
      .where(eq(tavTable.id, tav.id));

    expect(tavRow?.xp).toBe(6);

    const [skillRow] = await db
      .select({ xp: skill.xp })
      .from(skill)
      .where(and(eq(skill.tavId, tav.id), eq(skill.id, "logging")));

    expect(skillRow?.xp).toBe(20);

    const inventoryRows = await db
      .select()
      .from(inventory)
      .where(eq(inventory.tavId, tav.id));

    expect(inventoryRows).toContainEqual(
      expect.objectContaining({ itemId: "log", qty: 2 }),
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

    const outcome = await tickTask(db, {
      tavId: tav.id,
      lastTickAt: new Date(0),
      now: new Date(4000),
      context: { customChecks: { logging_allowed: true } },
    });

    expect(outcome.completed).toEqual([
      { tavId: tav.id, skillId: "logging", targetId: "small_tree" },
      { tavId: tav.id, skillId: "logging", targetId: "small_tree" },
    ]);

    expect(outcome.started).toEqual([
      { tavId: tav.id, skillId: "logging", targetId: "small_tree" },
      { tavId: tav.id, skillId: "logging", targetId: "small_tree" },
      { tavId: tav.id, skillId: "wood_craft", targetId: "plank" },
    ]);

    const inventoryRows = await db
      .select()
      .from(inventory)
      .where(eq(inventory.tavId, tav.id));

    expect(inventoryRows).toContainEqual(
      expect.objectContaining({ itemId: "log", qty: 2 }),
    );
  });
});
