import { describe, expect, it } from "vitest";

import {
  DEFAULT_TAV_ABILITY_SCORES,
  SKILL_DEFINITIONS,
  SKILL_TARGET_DEFINITIONS,
} from "./config.js";
import { TASK_TARGETLESS_KEY } from "./db/schema.js";

describe("config schema", () => {
  it("exposes default ability scores", () => {
    expect(DEFAULT_TAV_ABILITY_SCORES).toEqual({
      str: 10,
      dex: 10,
      con: 10,
      int: 10,
      wis: 10,
      cha: 10,
    });
  });

  it("loads skill definitions from the config file", () => {
    expect(SKILL_DEFINITIONS).toContainEqual({
      id: "logging",
      name: "Logging",
      description: "logging the wood",
      priority: 5,
      targetIds: ["small_tree", "big_tree"],
      duration: 2000,
      addRequirements: [],
      executeRequirements: [
        { op: "ability_min", ability: "str", value: 10 },
        { op: "custom", name: "logging_allowed" },
      ],
    });

    expect(SKILL_DEFINITIONS).toContainEqual({
      id: "wood_craft",
      name: "Wood Craft",
      description: "Craft the wood",
      priority: 5,
      targetIds: ["plank"],
      duration: 2000,
      addRequirements: [
        { op: "skill_level_min", skillId: "logging", level: 2 },
        { op: "flag_present", flagId: "sawmill_ready" },
      ],
      executeRequirements: [
        { op: "item_required", itemId: "log", quantity: 1 },
      ],
    });

    expect(SKILL_DEFINITIONS).toContainEqual({
      id: "idle",
      name: "Idle",
      description: "Do nothing",
      priority: 5,
      targetIds: [TASK_TARGETLESS_KEY],
      duration: 2000,
      addRequirements: [],
      executeRequirements: [],
    });

    expect(SKILL_DEFINITIONS).toContainEqual({
      id: "survey",
      name: "Survey",
      description: "Scout the surroundings",
      priority: 3,
      targetIds: ["forest_edge", "mountain_pass"],
      duration: 2000,
      addRequirements: [],
      executeRequirements: [
        {
          op: "or",
          requirements: [
            { op: "flag_present", flagId: "scout_ready" },
            { op: "skill_level_min", skillId: "logging", level: 3 },
          ],
        },
      ],
    });
  });

  it("loads skill target definitions from the config file", () => {
    expect(SKILL_TARGET_DEFINITIONS).toContainEqual({
      id: "small_tree",
      name: "Small tree",
      description: "a small tree",
      addRequirements: [{ op: "flag_present", flagId: "forest_access" }],
      executeRequirements: [],
    });
    expect(SKILL_TARGET_DEFINITIONS).toContainEqual({
      id: "big_tree",
      name: "Big tree",
      description: "a towering tree",
      addRequirements: [],
      executeRequirements: [{ op: "ability_min", ability: "str", value: 12 }],
    });
    expect(SKILL_TARGET_DEFINITIONS).toContainEqual({
      id: "plank",
      name: "Plank",
      description: "a wooden plank",
      addRequirements: [{ op: "flag_present", flagId: "sawmill_ready" }],
      executeRequirements: [],
    });

    expect(SKILL_TARGET_DEFINITIONS).toContainEqual({
      id: "forest_edge",
      name: "Forest edge",
      description: "a dense treeline",
      addRequirements: [],
      executeRequirements: [
        {
          op: "and",
          requirements: [
            { op: "flag_present", flagId: "forest_access" },
            { op: "item_required", itemId: "torch", quantity: 1 },
          ],
        },
      ],
    });

    expect(SKILL_TARGET_DEFINITIONS).toContainEqual({
      id: "mountain_pass",
      name: "Mountain pass",
      description: "a steep mountain pass",
      addRequirements: [{ op: "ability_min", ability: "con", value: 11 }],
      executeRequirements: [{ op: "custom", name: "weather_clear" }],
    });
  });
});
