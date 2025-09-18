import { readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

import {
  abilityScoresSchema,
  skillDefinitionSchema,
  skillTargetDefinitionSchema,
  type AbilityScores,
  type SkillDefinition,
  type SkillTargetDefinition,
} from "./db/schema.js";

const configSchema = z.object({
  defaults: z.object({
    ability_scores: abilityScoresSchema,
  }),
  skills: z.array(skillDefinitionSchema),
  skill_targets: z.array(skillTargetDefinitionSchema),
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

export const SKILL_DEFINITIONS: SkillDefinition[] = loadedConfig.skills;

export const SKILL_TARGET_DEFINITIONS: SkillTargetDefinition[] =
  loadedConfig.skill_targets;
