import { eq } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";

import { DEFAULT_TAV_ABILITY_SCORES } from "../config.js";
import * as schema from "./schema.js";

type DatabaseClient = PgliteDatabase<typeof schema>;

const { tav } = schema;

export type TavRecord = typeof schema.tav.$inferSelect;

export type CreateTavInput = {
  name: string;
};

export async function createTav(
  db: DatabaseClient,
  input: CreateTavInput,
): Promise<TavRecord> {
  const [created] = await db
    .insert(tav)
    .values({
      name: input.name,
      abilityScores: DEFAULT_TAV_ABILITY_SCORES,
    })
    .returning();
  return created;
}

export async function getTavById(
  db: DatabaseClient,
  tavId: number,
): Promise<TavRecord | null> {
  const [found] = await db.select().from(tav).where(eq(tav.id, tavId)).limit(1);

  return found ?? null;
}

export async function getTavWithRelations(db: DatabaseClient, tavId: number) {
  const result = await db.query.tav.findFirst({
    where: eq(tav.id, tavId),
    with: {
      skills: true,
      tasks: true,
      inventory: true,
    },
  });

  return result ?? null;
}

export async function deleteTav(
  db: DatabaseClient,
  tavId: number,
): Promise<TavRecord | null> {
  const deleted = await db.delete(tav).where(eq(tav.id, tavId)).returning();

  return deleted[0] ?? null;
}
