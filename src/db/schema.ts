import { jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export type AbilityScores = {
  str: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
};

export const visitLog = pgTable("visit_log", {
  id: serial().primaryKey(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const tav = pgTable("tav", {
  id: serial().primaryKey(),
  name: text("name").notNull(),
  abilityScores: jsonb("ability_scores").$type<AbilityScores>().notNull(),
});
