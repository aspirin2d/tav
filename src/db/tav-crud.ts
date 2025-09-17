import { eq } from "drizzle-orm";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";

import { DEFAULT_TAV_ABILITY_SCORES } from "../config.js";
import type { AbilityScores } from "./schema.js";
import { tav } from "./schema.js";
import type * as schema from "./schema.js";

type TavDatabase = PgliteDatabase<typeof schema>;

export type TavRow = InferSelectModel<typeof tav>;
export type CreateTavInput = {
  name: string;
  abilityScores?: AbilityScores;
};
export type UpdateTavInput = Partial<Omit<InferInsertModel<typeof tav>, "id" | "abilityScores" >> & {
  abilityScores?: AbilityScores;
};

export async function insertTav(
  db: TavDatabase,
  input: CreateTavInput,
): Promise<TavRow> {
  const values = {
    name: input.name,
    abilityScores: {
      ...(input.abilityScores ?? DEFAULT_TAV_ABILITY_SCORES),
    },
  } satisfies Omit<InferInsertModel<typeof tav>, "id">;

  const [row] = await db.insert(tav).values(values).returning();
  if (!row) {
    throw new Error("Failed to insert tav");
  }
  return row;
}

export async function getTavById(
  db: TavDatabase,
  id: number,
): Promise<TavRow | undefined> {
  const [row] = await db.select().from(tav).where(eq(tav.id, id));
  return row;
}

export async function updateTav(
  db: TavDatabase,
  id: number,
  updates: UpdateTavInput,
): Promise<TavRow | undefined> {
  const updateValues: Partial<InferInsertModel<typeof tav>> = {};

  if (updates.name !== undefined) {
    updateValues.name = updates.name;
  }

  if (updates.abilityScores !== undefined) {
    updateValues.abilityScores = { ...updates.abilityScores };
  }

  if (Object.keys(updateValues).length === 0) {
    return getTavById(db, id);
  }

  const [row] = await db
    .update(tav)
    .set(updateValues)
    .where(eq(tav.id, id))
    .returning();

  return row;
}

export async function deleteTav(
  db: TavDatabase,
  id: number,
): Promise<TavRow | undefined> {
  const [row] = await db.delete(tav).where(eq(tav.id, id)).returning();
  return row;
}

export async function listTavs(db: TavDatabase): Promise<TavRow[]> {
  return db.select().from(tav);
}
