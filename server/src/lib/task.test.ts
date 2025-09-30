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

  it("does not start work-gated tasks during a non-work block", async () => {
    // Create a schedule where the first block is downtime and the second is work
    const blocks = Array.from({ length: 24 }, (_, i) => (i === 0 ? "downtime" : "work"));
    const [sched] = await db
      .insert(schema.schedule)
      .values({ name: "daytime", description: "", blocks })
      .returning();

    const t = await createTav(db, { name: "ScheduleGate" });

    // Assign the schedule to the tav
    await db
      .update(tavTable)
      .set({ scheduleId: sched.id })
      .where(eq(tavTable.id, t.id));

    // Queue a task whose execute requires schedule_block_work (e.g., meditate)
    await addTask(db, { tavId: t.id, skillId: "meditate", targetId: null });

    // At t=0 we are in block 0 = downtime, so meditate should not start
    const out0 = await tickTask(db, { tavId: t.id, lastTickAt: new Date(0), now: new Date(100) });
    expect(out0.started).toHaveLength(0);
    expect(out0.completed).toHaveLength(0);

    // Move cursor to the start of block 1 (work) and it should start now
    const out1 = await tickTask(db, { tavId: t.id, lastTickAt: new Date(25_000), now: new Date(25_100) });
    expect(out1.started).toEqual([
      { tavId: t.id, skillId: "meditate", targetId: schema.TASK_TARGETLESS_KEY },
    ]);
  });

  it("starts work-gated tasks with default schedule assigned", async () => {
    const t = await createTav(db, { name: "DefaultWork" });

    // meditate is gated by schedule_block_work only; default schedule is all work blocks
    await addTask(db, { tavId: t.id, skillId: "meditate", targetId: null });

    const out = await tickTask(db, { tavId: t.id, lastTickAt: new Date(0), now: new Date(50) });
    expect(out.started).toEqual([
      { tavId: t.id, skillId: "meditate", targetId: schema.TASK_TARGETLESS_KEY },
    ]);
  });

  it("does not peek ahead within the window to future work blocks", async () => {
    // First block is downtime; all subsequent are work
    const blocks = Array.from({ length: 24 }, (_, i) => (i === 0 ? "downtime" : "work"));
    const [sched] = await db
      .insert(schema.schedule)
      .values({ name: "no_peek", description: "", blocks })
      .returning();

    const t = await createTav(db, { name: "NoPeek" });
    await db
      .update(tavTable)
      .set({ scheduleId: sched.id })
      .where(eq(tavTable.id, t.id));

    await addTask(db, { tavId: t.id, skillId: "meditate", targetId: null });

    // Window spans into a future work block, but scheduler evaluates at current cursor only
    const out = await tickTask(db, { tavId: t.id, lastTickAt: new Date(0), now: new Date(26_000) });
    expect(out.started).toHaveLength(0);
    expect(out.completed).toHaveLength(0);
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

  it("throws when tav is not found", async () => {
    await expect(
      tickTask(db, { tavId: 9999, now: new Date(0) }),
    ).rejects.toThrow(/character not found/);
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

  it("throws when executing task has no startedAt", async () => {
    const created = await createTav(db, { name: "MissingStartedAt" });

    // Ensure the skill row exists (known skill from config)
    await db.insert(skill).values({ tavId: created.id, id: "idle" });

    // Insert executing task without startedAt
    await db.insert(task).values({
      tavId: created.id,
      skillId: "idle",
      targetId: schema.TASK_TARGETLESS_KEY,
      status: "executing",
    });

    await expect(
      tickTask(db, { tavId: created.id, lastTickAt: new Date(0), now: new Date(10) }),
    ).rejects.toThrow(/startedAt is not set for task/);
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

  it("builds requirement context from DB state only", async () => {
    const created = await createTav(db, { name: "CtxFromDBOnly" });

    // DB provides both the forest access for target and scout_ready for skill execute
    await db
      .update(tavTable)
      .set({ flags: ["forest_access", "scout_ready"] })
      .where(eq(tavTable.id, created.id));

    // Provide the torch via DB inventory
    await db.insert(inventory).values({
      tavId: created.id,
      slot: 1,
      itemId: "torch",
      qty: 1,
    });

    await addTask(db, {
      tavId: created.id,
      skillId: "survey",
      targetId: "forest_edge",
    });

    const outcome = await tickTask(db, { tavId: created.id, lastTickAt: new Date(0), now: new Date(100) });

    expect(outcome.started).toEqual([
      { tavId: created.id, skillId: "survey", targetId: "forest_edge" },
    ]);
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

  it("uses override requirement context when provided", async () => {
    const created = await createTav(db, { name: "CtxMerge" });

    // DB has no torch; only forest_access so target add requirements are satisfied when needed
    await db
      .update(tavTable)
      .set({ flags: ["forest_access"] })
      .where(eq(tavTable.id, created.id));

    await addTask(db, {
      tavId: created.id,
      skillId: "survey",
      targetId: "forest_edge",
    });

    // Provide scout_ready and forest_access flags and a torch via override context only
    const outcome = await tickTask(db, {
      tavId: created.id,
      lastTickAt: new Date(0),
      now: new Date(100),
      context: { flags: new Set(["scout_ready", "forest_access"]), inventory: { torch: 1 } },
    });

    expect(outcome.started).toEqual([
      { tavId: created.id, skillId: "survey", targetId: "forest_edge" },
    ]);
  });

  it("can start a craft using inventory provided via context only", async () => {
    const tav = await createTav(db, { name: "ContextInventory" });

    await db
      .update(tavTable)
      .set({ flags: ["sawmill_ready"] })
      .where(eq(tavTable.id, tav.id));

    // Meet add requirements: logging level >= 2
    await db.insert(skill).values({ tavId: tav.id, id: "logging", xp: 20 });

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

  it("does not start when target execute requirements fail while skill passes", async () => {
    const created = await createTav(db, { name: "TargetExecFail" });

    // Make skill execute pass via scout_ready, but do not provide torch (target requirement)
    await db
      .update(tavTable)
      .set({ flags: ["scout_ready", "forest_access"] })
      .where(eq(tavTable.id, created.id));

    await addTask(db, {
      tavId: created.id,
      skillId: "survey",
      targetId: "forest_edge",
    });

    const outcome = await tickTask(db, { tavId: created.id, lastTickAt: new Date(0), now: new Date(100) });

    expect(outcome.started).toHaveLength(0);
    expect(outcome.completed).toHaveLength(0);

    const [row] = await db.select().from(task).where(eq(task.tavId, created.id));
    expect(row.status).toBe("pending");
  });

  it("addToInventoryContext aggregates newly gained items to enable crafting in the same tick", async () => {
    const t = await createTav(db, { name: "CtxAddAggregate" });

    // Base: 1 log in DB, sawmill ready, forest access; logging level 3 so wood_craft add req passes
    await db
      .update(tavTable)
      .set({ flags: ["forest_access", "sawmill_ready"] })
      .where(eq(tavTable.id, t.id));

    await db.insert(skill).values({ tavId: t.id, id: "logging", xp: 20 });

    // Inventory has only 1 log initially
    await db.insert(inventory).values({ tavId: t.id, slot: 1, itemId: "log", qty: 1 });

    // Queue logging then wood craft
    await addTask(db, { tavId: t.id, skillId: "logging", targetId: "small_tree" });
    await addTask(db, { tavId: t.id, skillId: "wood_craft", targetId: "plank" });

    const out = await tickTask(db, {
      tavId: t.id,
      lastTickAt: new Date(0),
      now: new Date(3000),
      context: { customChecks: { logging_allowed: true } },
    });

    // Logging completes once, then crafting starts immediately using updated requirement context (2 logs total)
    expect(out.completed).toContainEqual({ tavId: t.id, skillId: "logging", targetId: "small_tree" });
    expect(out.started).toContainEqual({ tavId: t.id, skillId: "wood_craft", targetId: "plank" });
  });

  it("addToInventoryContext works when requirementContext.inventory is undefined", async () => {
    const t = await createTav(db, { name: "CtxInvUndefined" });

    await db
      .update(tavTable)
      .set({ flags: ["forest_access", "sawmill_ready"] })
      .where(eq(tavTable.id, t.id));

    await db.insert(skill).values({ tavId: t.id, id: "logging", xp: 20 });

    // Queue one logging task and a craft; logging will recycle twice within the window
    await addTask(db, { tavId: t.id, skillId: "logging", targetId: "small_tree" });
    await addTask(db, { tavId: t.id, skillId: "wood_craft", targetId: "plank" });

    const out = await tickTask(db, {
      tavId: t.id,
      lastTickAt: new Date(0),
      now: new Date(4000),
      context: { inventory: undefined, customChecks: { logging_allowed: true } },
    });

    // After two logging completions, crafting should start; proves inventory started undefined and was created/aggregated
    expect(out.completed).toContainEqual({ tavId: t.id, skillId: "logging", targetId: "small_tree" });
    expect(out.started).toContainEqual({ tavId: t.id, skillId: "wood_craft", targetId: "plank" });
  });

  it("addToInventoryContext works when requirementContext.inventory is null", async () => {
    const t = await createTav(db, { name: "CtxInvNull" });

    await db
      .update(tavTable)
      .set({ flags: ["forest_access", "sawmill_ready"] })
      .where(eq(tavTable.id, t.id));

    await db.insert(skill).values({ tavId: t.id, id: "logging", xp: 20 });

    // One logging task is enough; it will recycle twice
    await addTask(db, { tavId: t.id, skillId: "logging", targetId: "small_tree" });
    await addTask(db, { tavId: t.id, skillId: "wood_craft", targetId: "plank" });

    const out = await tickTask(db, {
      tavId: t.id,
      lastTickAt: new Date(0),
      now: new Date(4000),
      context: { inventory: null as any, customChecks: { logging_allowed: true } },
    });

    expect(out.completed).toContainEqual({ tavId: t.id, skillId: "logging", targetId: "small_tree" });
    expect(out.started).toContainEqual({ tavId: t.id, skillId: "wood_craft", targetId: "plank" });
  });

  it("addToInventoryContext applies consumption so subsequent tasks remain ineligible in the same tick", async () => {
    const t = await createTav(db, { name: "CtxConsume" });

    await db
      .update(tavTable)
      .set({ flags: ["sawmill_ready"] })
      .where(eq(tavTable.id, t.id));

    await db.insert(skill).values({ tavId: t.id, id: "logging", xp: 20 });

    // Exactly enough logs for one craft
    await db.insert(inventory).values({ tavId: t.id, slot: 1, itemId: "log", qty: 2 });

    // Queue one craft; it should complete once and not immediately restart due to consumption
    await addTask(db, { tavId: t.id, skillId: "wood_craft", targetId: "plank" });

    const out = await tickTask(db, { tavId: t.id, lastTickAt: new Date(0), now: new Date(3000) });

    expect(out.completed).toContainEqual({ tavId: t.id, skillId: "wood_craft", targetId: "plank" });
    // The same craft should not start a second time due to logs consumed via addToInventoryContext in the same tick
    const startedCrafts = out.started.filter(
      (k) => k.skillId === "wood_craft" && k.targetId === "plank",
    );
    expect(startedCrafts.length).toBe(1);
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

  it("for the same skill, per-task priority determines selection", async () => {
    const t = await createTav(db, { name: "SameSkillPriority" });

    // Allow survey targets and execution
    const [row] = await db
      .select()
      .from(tavTable)
      .where(eq(tavTable.id, t.id));

    await db
      .update(tavTable)
      .set({
        flags: ["forest_access", "scout_ready"],
        abilityScores: { ...row.abilityScores, con: 11 }, // for mountain_pass add requirement
      })
      .where(eq(tavTable.id, t.id));

    // Same skill (survey) but different targets and task priorities
    await addTask(db, { tavId: t.id, skillId: "survey", targetId: "forest_edge", priority: 1 });
    await addTask(db, { tavId: t.id, skillId: "survey", targetId: "mountain_pass", priority: 9 });

    const out = await tickTask(db, {
      tavId: t.id,
      lastTickAt: new Date(0),
      now: new Date(100),
      context: {
        // forest_edge execute requires a torch; mountain_pass requires clear weather
        inventory: { torch: 1 },
        customChecks: { weather_clear: true },
      },
    });

    expect(out.started[0]).toEqual({
      tavId: t.id,
      skillId: "survey",
      targetId: "mountain_pass",
    });
  });

  it("defaults to zero offset (5) and uses createdAt when tied for the same skill", async () => {
    const t = await createTav(db, { name: "SameSkillTieBreak" });

    // Permit both survey targets
    const [row] = await db
      .select()
      .from(tavTable)
      .where(eq(tavTable.id, t.id));

    await db
      .update(tavTable)
      .set({
        flags: ["forest_access", "scout_ready"],
        abilityScores: { ...row.abilityScores, con: 11 },
      })
      .where(eq(tavTable.id, t.id));

    // Insert forest_edge first (older createdAt), both with default priority (5)
    await addTask(db, { tavId: t.id, skillId: "survey", targetId: "forest_edge" });
    await addTask(db, { tavId: t.id, skillId: "survey", targetId: "mountain_pass" });

    const out = await tickTask(db, {
      tavId: t.id,
      lastTickAt: new Date(0),
      now: new Date(100),
      context: { inventory: { torch: 1 }, customChecks: { weather_clear: true } },
    });

    expect(out.started[0]).toEqual({
      tavId: t.id,
      skillId: "survey",
      targetId: "forest_edge",
    });
  });

  it("considers per-task priority when selecting next", async () => {
    const t = await createTav(db, { name: "PerTaskPriority" });

    // Satisfy add/execute requirements for both skills
    await db
      .update(tavTable)
      .set({ flags: ["forest_access", "scout_ready"] })
      .where(eq(tavTable.id, t.id));

    // Base priorities: logging=5, survey=3
    // Boost survey (+4) and dampen logging (-4) so survey wins overall
    await addTask(db, {
      tavId: t.id,
      skillId: "logging",
      targetId: "small_tree",
      priority: 1, // offset -4
    });

    await addTask(db, {
      tavId: t.id,
      skillId: "survey",
      targetId: "forest_edge",
      priority: 9, // offset +4
    });

    const out = await tickTask(db, {
      tavId: t.id,
      lastTickAt: new Date(0),
      now: new Date(100),
      context: { customChecks: { logging_allowed: true }, inventory: { torch: 1 } },
    });

    expect(out.started[0]).toEqual({
      tavId: t.id,
      skillId: "survey",
      targetId: "forest_edge",
    });
  });

  it("uses tav level requirements within the same tick window", async () => {
    const t = await createTav(db, { name: "TavLevelTick" });

    // Queue meditate first (lower priority) and then scribe (higher priority but gated by tav level >= 2)
    await addTask(db, { tavId: t.id, skillId: "meditate", targetId: null });
    await addTask(db, { tavId: t.id, skillId: "scribe", targetId: null });

    const out = await tickTask(db, {
      tavId: t.id,
      lastTickAt: new Date(0),
      now: new Date(3000),
    });

    // Meditate completes once and then scribe becomes eligible due to tav level rising to 2
    expect(out.completed).toContainEqual({ tavId: t.id, skillId: "meditate", targetId: schema.TASK_TARGETLESS_KEY });
    expect(out.started).toContainEqual({ tavId: t.id, skillId: "scribe", targetId: schema.TASK_TARGETLESS_KEY });
  });

  it("uses skill level requirements within the same tick window", async () => {
    const t = await createTav(db, { name: "SkillLevelTick" });

    // Allow logging add requirements (forest_access) and custom execute guard
    await db
      .update(tavTable)
      .set({ flags: ["forest_access"] })
      .where(eq(tavTable.id, t.id));

    // Queue logging (will recycle to gain skill XP) and scribe_pro which requires logging level >= 3
    await addTask(db, { tavId: t.id, skillId: "logging", targetId: "small_tree" });
    await addTask(db, { tavId: t.id, skillId: "scribe_pro", targetId: null });

    const out = await tickTask(db, {
      tavId: t.id,
      lastTickAt: new Date(0),
      now: new Date(5000),
      context: { customChecks: { logging_allowed: true } },
    });

    // Two logging completions raise logging xp to 20 (level 3), enabling scribe_pro (higher priority)
    expect(out.completed.filter((k) => k.skillId === "logging")).toHaveLength(2);
    expect(out.started).toContainEqual({
      tavId: t.id,
      skillId: "scribe_pro",
      targetId: schema.TASK_TARGETLESS_KEY,
    });
  });

  it("self-referential skill_level_min allows repeated cycles when level is met", async () => {
    const t = await createTav(db, { name: "SelfRef" });

    // Seed self_train with xp that yields level 2 (>=10)
    await db.insert(skill).values({ tavId: t.id, id: "self_train", xp: 10 });

    await addTask(db, { tavId: t.id, skillId: "self_train", targetId: null });

    const out = await tickTask(db, { tavId: t.id, lastTickAt: new Date(0), now: new Date(5000) });

    // Duration=2000ms → expect two completions and two restarts within window
    const completedSelf = out.completed.filter((k) => k.skillId === "self_train");
    const startedSelf = out.started.filter((k) => k.skillId === "self_train");
    expect(completedSelf.length).toBeGreaterThanOrEqual(2);
    expect(startedSelf.length).toBeGreaterThanOrEqual(2);
  });

  it("when multiple tasks unlock simultaneously, picks highest priority first", async () => {
    const t = await createTav(db, { name: "MultiUnlock" });

    // Queue actions: meditate raises tav level; two gated tasks require tav level 2
    await addTask(db, { tavId: t.id, skillId: "meditate", targetId: null });
    await addTask(db, { tavId: t.id, skillId: "scribe", targetId: null });
    await addTask(db, { tavId: t.id, skillId: "scribe_elite", targetId: null });

    const out = await tickTask(db, {
      tavId: t.id,
      lastTickAt: new Date(0),
      // Enough for meditate to complete once, but not enough to finish a following task
      now: new Date(2500),
    });

    // After meditate completes at t=2000, both scribe tasks unlock.
    // Scheduler should start the higher-priority one (scribe_elite) first.
    const started = out.started
      .filter((k) => k.skillId === "scribe" || k.skillId === "scribe_elite")
      .map((k) => k.skillId);
    expect(started).toContain("scribe_elite");
    expect(started).not.toContain("scribe");
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

    await db.insert(skill).values({ tavId: tav.id, id: "logging", xp: 20 });

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
