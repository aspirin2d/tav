import { describe, expect, it } from "vitest";

import {
  DEFAULT_TAV_ABILITY_SCORES,
  SKILL_DEFINITIONS,
  TARGET_DEFINITIONS,
  ITEM_DEFINITIONS,
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
    expect(SKILL_DEFINITIONS).toContainEqual(
      expect.objectContaining({
        id: "logging",
        name: "Logging",
        description: "logging the wood",
        priority: 5,
        targetIds: ["small_tree", "big_tree"],
        duration: 2000,
        addRequirements: [],
        executeRequirements: expect.arrayContaining([
          { op: "ability_min", ability: "str", value: 10 },
          { op: "custom", name: "logging_allowed" },
          { op: "flag_present", flagId: "schedule_block_work" },
        ]),
      }),
    );

    expect(SKILL_DEFINITIONS).toContainEqual(
      expect.objectContaining({
        id: "wood_craft",
        name: "Wood Craft",
        description: "Craft the wood",
        priority: 6,
        targetIds: ["plank"],
        duration: 2000,
        addRequirements: [
          { op: "skill_level_min", skillId: "logging", level: 2 },
          { op: "flag_present", flagId: "sawmill_ready" },
        ],
        executeRequirements: expect.arrayContaining([
          { op: "item_required", itemId: "log", quantity: 2 },
          { op: "flag_present", flagId: "schedule_block_work" },
        ]),
      }),
    );

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

    expect(SKILL_DEFINITIONS).toContainEqual(
      expect.objectContaining({
        id: "survey",
        name: "Survey",
        description: "Scout the surroundings",
        priority: 3,
        targetIds: ["forest_edge", "mountain_pass"],
        duration: 2000,
        addRequirements: [],
        executeRequirements: expect.arrayContaining([
          {
            op: "or",
            requirements: [
              { op: "flag_present", flagId: "scout_ready" },
              { op: "skill_level_min", skillId: "logging", level: 3 },
            ],
          },
          { op: "flag_present", flagId: "schedule_block_work" },
        ]),
      }),
    );
  });

  it("loads target definitions from the config file", () => {
    expect(TARGET_DEFINITIONS).toContainEqual(
      expect.objectContaining({
        id: "small_tree",
        name: "Small tree",
        description: "a small tree",
        addRequirements: [{ op: "flag_present", flagId: "forest_access" }],
        executeRequirements: [],
        skills: ["logging", "survey"],
        completionEffect: {
          tavXp: 3,
          skillXp: 10,
          inventory: { log: 1 },
        },
      }),
    );

    expect(TARGET_DEFINITIONS).toContainEqual(
      expect.objectContaining({
        id: "big_tree",
        name: "Big tree",
        description: "a towering tree",
        addRequirements: [],
        executeRequirements: [{ op: "ability_min", ability: "str", value: 12 }],
        skills: ["logging"],
        completionEffect: {
          tavXp: 4,
          skillXp: 12,
          inventory: { log: 2 },
        },
      }),
    );

    expect(TARGET_DEFINITIONS).toContainEqual(
      expect.objectContaining({
        id: "plank",
        name: "Plank",
        description: "a wooden plank",
        addRequirements: [{ op: "flag_present", flagId: "sawmill_ready" }],
        executeRequirements: [],
        skills: ["wood_craft"],
        completionEffect: {
          skillXp: 15,
          inventory: { log: -2, plank: 1 },
        },
      }),
    );

    expect(TARGET_DEFINITIONS).toContainEqual(
      expect.objectContaining({
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
        skills: ["survey"],
        completionEffect: { tavXp: 5 },
      }),
    );

    expect(TARGET_DEFINITIONS).toContainEqual(
      expect.objectContaining({
        id: "mountain_pass",
        name: "Mountain pass",
        description: "a steep mountain pass",
        addRequirements: [{ op: "ability_min", ability: "con", value: 11 }],
        executeRequirements: [{ op: "custom", name: "weather_clear" }],
        skills: ["survey"],
        completionEffect: { tavXp: 7 },
      }),
    );
  });

  it("loads item definitions from the config file", () => {
    expect(ITEM_DEFINITIONS).toContainEqual(
      expect.objectContaining({
        id: "log",
        name: "Log",
        stackLimit: 99,
        weight: 2,
        value: 3,
        tags: ["resource", "wood"],
      }),
    );

    expect(ITEM_DEFINITIONS).toContainEqual(
      expect.objectContaining({
        id: "torch",
        stackLimit: 5,
        tags: ["utility", "light_source"],
      }),
    );
  });
});
