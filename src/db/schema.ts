import { jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import z from "zod";

export const abilityScoresSchema = z.object({
  str: z.number().int().min(0).max(30),
  dex: z.number().int().min(0).max(30),
  con: z.number().int().min(0).max(30),
  int: z.number().int().min(0).max(30),
  wis: z.number().int().min(0).max(30),
  cha: z.number().int().min(0).max(30),
});

export const skillSchema = z.object({});

export type AbilityScores = z.infer<typeof abilityScoresSchema>;

export const visitLog = pgTable("visit_log", {
  id: serial().primaryKey(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const tav = pgTable("tav", {
  id: serial().primaryKey(),
  name: text("name").notNull(),
  abilityScores: jsonb("ability_scores").$type<AbilityScores>().notNull(),
});
