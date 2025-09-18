import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  createTav,
  deleteTav,
  getTavById,
  getTavWithRelations,
} from "./tav.js";
import * as schema from "./schema.js";
import { DEFAULT_TAV_ABILITY_SCORES } from "../config.js";

const { skill, inventory, task } = schema;

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

    await db
      .insert(skill)
      .values({ tavId: created.id, skillId: "intimidation" });
    await db
      .insert(task)
      .values({ tavId: created.id, skillId: "intimidation" });
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
      expect.objectContaining({
        tavId: created.id,
        skillId: "intimidation",
      }),
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
});
