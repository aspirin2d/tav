import { readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

import {
  abilityScoresSchema,
  itemDefinitionSchema,
  skillDefinitionSchema,
  targetDefinitionSchema,
  type AbilityScores,
  type ItemDefinition,
  type SkillDefinition,
  type TargetDefinition,
} from "./db/schema.js";

const configSchema = z.object({
  defaults: z.object({
    stack_limit: z.int().min(1).max(99),
    max_loop_limit: z.int().min(1).max(99),
    ability_scores: abilityScoresSchema,
  }),
  skills: z.array(skillDefinitionSchema),
  targets: z.array(targetDefinitionSchema),
  items: z.array(itemDefinitionSchema),
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

export const DEfAULT_STACK_LIMIT = loadedConfig.defaults.stack_limit;
export const MAX_LOOP_LIMIT = loadedConfig.defaults.max_loop_limit;

export const SKILL_DEFINITIONS: SkillDefinition[] = loadedConfig.skills;

export const TARGET_DEFINITIONS: TargetDefinition[] = loadedConfig.targets;
export const ITEM_DEFINITIONS: ItemDefinition[] = loadedConfig.items;
