import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  addTask,
  canExecuteTask,
  createTav,
  deleteTav,
  getTavById,
  getTavWithRelations,
} from "./tav.js";
import * as schema from "./schema.js";
import { DEFAULT_TAV_ABILITY_SCORES } from "../config.js";

const { skill, inventory, task, tav: tavTable } = schema;

type DatabaseClient = PgliteDatabase<typeof schema>;

function migrationsPath(): string {
  const url = import.meta.url;
  const currentDir = dirname(fileURLToPath(url));
  return join(currentDir, "../../drizzle");
}

describe("tav database helpers", () => {
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

  it("creates a tav with the configured defaults", async () => {
    const created = await createTav(db, { name: "Shadowheart" });

    expect(created).toBeTruthy();
    expect(created.name).toBe("Shadowheart");
    expect(created.abilityScores).toEqual(DEFAULT_TAV_ABILITY_SCORES);
    expect(created.hpCurrent).toBe(10);

    const fetched = await getTavById(db, created.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.name).toBe("Shadowheart");
  });

  it("returns null when a tav is missing", async () => {
    const fetched = await getTavById(db, 999);
    expect(fetched).toBeNull();
  });

  it("loads a tav alongside skills, tasks, and inventory", async () => {
    const created = await createTav(db, { name: "Karlach" });

    const intimidationSkill = {
      tavId: created.id,
      id: "intimidation",
    } satisfies typeof skill.$inferInsert;

    await db.insert(skill).values(intimidationSkill);
    await db.insert(task).values({
      tavId: created.id,
      skillId: "intimidation",
      targetId: "goblin_camp",
    });
    await db
      .insert(inventory)
      .values({ tavId: created.id, slot: 0, itemId: "infernal_engine" });

    const result = await getTavWithRelations(db, created.id);

    expect(result).not.toBeNull();
    if (!result) {
      throw new Error("Expected tav with relations");
    }
    const tavWithRelations = result;

    expect(tavWithRelations.skills).toHaveLength(1);
    expect(tavWithRelations.skills[0]).toEqual(
      expect.objectContaining(intimidationSkill),
    );
    expect(tavWithRelations.tasks).toHaveLength(1);
    expect(tavWithRelations.inventory).toHaveLength(1);
  });

  it("deletes a tav and returns the removed record", async () => {
    const created = await createTav(db, { name: "Lae'zel" });

    const deleted = await deleteTav(db, created.id);
    expect(deleted!.id).toEqual(created.id);

    const afterDeletion = await getTavById(db, created.id);
    expect(afterDeletion).toBeNull();
  });

  it("adds a task for a tav and ensures the skill row exists", async () => {
    const created = await createTav(db, { name: "Wyll" });

    await db
      .update(tavTable)
      .set({ flags: ["forest_access"] })
      .where(eq(tavTable.id, created.id));

    const newTask = await addTask(db, {
      tavId: created.id,
      skillId: "logging",
      targetId: "small_tree",
    });

    expect(newTask.skillId).toBe("logging");
    expect(newTask.targetId).toBe("small_tree");

    const skillRows = await db
      .select()
      .from(skill)
      .where(eq(skill.tavId, created.id));

    expect(skillRows).toHaveLength(1);
    expect(skillRows[0]).toMatchObject({ tavId: created.id, id: "logging" });
  });

  it("stores a null task target as the literal null key", async () => {
    const created = await createTav(db, { name: "Astarion" });

    const newTask = await addTask(db, {
      tavId: created.id,
      skillId: "idle",
      targetId: null,
    });

    expect(newTask.targetId).toBe(schema.TASK_TARGETLESS_KEY);

    const taskRows = await db
      .select()
      .from(task)
      .where(eq(task.tavId, created.id));

    expect(taskRows).toHaveLength(1);
    expect(taskRows[0]).toMatchObject({
      tavId: created.id,
      skillId: "idle",
      targetId: schema.TASK_TARGETLESS_KEY,
    });
  });

  it("adds a wood crafting task for a tav", async () => {
    const created = await createTav(db, { name: "Halfling" });

    await db
      .insert(skill)
      .values({ tavId: created.id, id: "logging", xpLevel: 3 });

    await db
      .update(tavTable)
      .set({ flags: ["sawmill_ready"] })
      .where(eq(tavTable.id, created.id));

    const newTask = await addTask(db, {
      tavId: created.id,
      skillId: "wood_craft",
      targetId: "plank",
    });

    expect(newTask.targetId).toBe("plank");
  });

  it("allows execution when survey requirements are met", async () => {
    const created = await createTav(db, { name: "Scout" });

    await db
      .update(tavTable)
      .set({
        flags: ["forest_access", "scout_ready"],
      })
      .where(eq(tavTable.id, created.id));

    const canSurveyEdge = await canExecuteTask(db, {
      tavId: created.id,
      skillId: "survey",
      targetId: "forest_edge",
      context: {
        inventory: { torch: 1 },
      },
    });

    expect(canSurveyEdge).toBe(true);

    const canSurveyMountainBlocked = await canExecuteTask(db, {
      tavId: created.id,
      skillId: "survey",
      targetId: "mountain_pass",
      context: {
        abilities: { con: 10 },
        customChecks: { weather_clear: false },
      },
    });

    expect(canSurveyMountainBlocked).toBe(false);

    const canSurveyMountainAllowed = await canExecuteTask(db, {
      tavId: created.id,
      skillId: "survey",
      targetId: "mountain_pass",
      context: {
        abilities: { con: 12 },
        customChecks: { weather_clear: true },
      },
    });

    expect(canSurveyMountainAllowed).toBe(true);
  });

  it("evaluates execute requirements for a tav", async () => {
    const created = await createTav(db, { name: "Larian" });

    await db
      .update(tavTable)
      .set({ flags: ["forest_access"] })
      .where(eq(tavTable.id, created.id));

    await addTask(db, {
      tavId: created.id,
      skillId: "logging",
      targetId: "small_tree",
    });

    const smallTree = await canExecuteTask(db, {
      tavId: created.id,
      skillId: "logging",
      targetId: "small_tree",
      context: { customChecks: { logging_allowed: true } },
    });

    expect(smallTree).toBe(true);

    const bigTreeBlocked = await canExecuteTask(db, {
      tavId: created.id,
      skillId: "logging",
      targetId: "big_tree",
      context: { customChecks: { logging_allowed: true } },
    });

    expect(bigTreeBlocked).toBe(false);

    const bigTreeAllowed = await canExecuteTask(db, {
      tavId: created.id,
      skillId: "logging",
      targetId: "big_tree",
      context: {
        abilities: { str: 12 },
        customChecks: { logging_allowed: true },
      },
    });

    expect(bigTreeAllowed).toBe(true);
  });

  it("rejects targets not configured for the skill", async () => {
    const created = await createTav(db, { name: "Jaheira" });

    await expect(
      addTask(db, {
        tavId: created.id,
        skillId: "wood_craft",
        targetId: "small_tree",
      }),
    ).rejects.toThrow(/cannot target id/);
  });

  it("rejects when add requirements are not satisfied", async () => {
    const created = await createTav(db, { name: "Minthara" });

    await db
      .insert(skill)
      .values({ tavId: created.id, id: "logging", xpLevel: 1 });

    await expect(
      addTask(db, {
        tavId: created.id,
        skillId: "wood_craft",
        targetId: "plank",
      }),
    ).rejects.toThrow(/Skill wood_craft requirements not met/);
  });

  it("rejects unknown skill ids", async () => {
    const created = await createTav(db, { name: "Gale" });

    await expect(
      addTask(db, {
        tavId: created.id,
        skillId: "arcane_blast",
        targetId: "small_tree",
      }),
    ).rejects.toThrow(/Unknown skill id/);
  });
});
