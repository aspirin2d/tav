import { readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

import type { AbilityScores } from "./db/schema.js";

const abilityScoresSchema = z.object({
  str: z.number().int().min(0).max(30),
  dex: z.number().int().min(0).max(30),
  con: z.number().int().min(0).max(30),
  int: z.number().int().min(0).max(30),
  wis: z.number().int().min(0).max(30),
  cha: z.number().int().min(0).max(30),
});

const configSchema = z.object({
  defaults: z.object({
    ability_scores: abilityScoresSchema,
  }),
});

type ConfigShape = z.infer<typeof configSchema>;

const configUrl = new URL("../data/config.toml", import.meta.url);

function loadConfig(): ConfigShape {
  const source = readFileSync(configUrl, "utf8");
  const parsed = parseToml(source);
  return configSchema.parse(parsed);
}

const loadedConfig = loadConfig();

export const DEFAULT_TAV_ABILITY_SCORES: AbilityScores =
  loadedConfig.defaults.ability_scores;
