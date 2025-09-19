import { eq } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";

import {
  DEFAULT_TAV_ABILITY_SCORES,
  SKILL_DEFINITIONS,
  TARGET_DEFINITIONS,
} from "../config.js";

import {
  evaluateRequirements,
  inventory,
  skill,
  task,
  tav,
  TASK_TARGETLESS_KEY,
  type RequirementEvaluationContext,
  type TargetDefinition,
} from "./schema.js";
import * as schema from "./schema.js";

type DatabaseClient = PgliteDatabase<typeof schema>;

export type TavRecord = typeof tav.$inferSelect;
export type TaskRecord = typeof task.$inferSelect;

export type CreateTavInput = {
  name: string;
};

export type AddTaskInput = {
  tavId: number;
  skillId: string;
  targetId?: string | null;
  context?: RequirementEvaluationContext;
};

export type CanExecuteTaskInput = {
  tavId: number;
  skillId: string;
  targetId?: string | null;
  context?: RequirementEvaluationContext;
  baseContext?: RequirementEvaluationContext;
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
      flags: [],
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

export async function addTask(
  db: DatabaseClient,
  input: AddTaskInput,
): Promise<TaskRecord> {
  const skillDefinition = SKILL_DEFINITIONS.find((definition) => {
    return definition.id === input.skillId;
  });

  if (!skillDefinition) {
    throw new Error(`Unknown skill id: ${input.skillId}`);
  }

  const targetId = input.targetId ?? TASK_TARGETLESS_KEY;

  const isAllowedTarget = skillDefinition.targetIds.includes(targetId);

  if (!isAllowedTarget) {
    throw new Error(`Skill ${input.skillId} cannot target id: ${targetId}`);
  }

  const baseContext = await buildRequirementContext(db, input.tavId);
  const context = mergeRequirementContexts(baseContext, input.context);

  if (!evaluateRequirements(skillDefinition.addRequirements, context)) {
    throw new Error(`Skill ${input.skillId} requirements not met`);
  }

  let targetDefinition = TARGET_DEFINITIONS.find((definition) => {
    return definition.id === targetId;
  });

  if (targetId !== TASK_TARGETLESS_KEY) {
    const isKnownTarget = Boolean(targetDefinition);

    if (!isKnownTarget) {
      throw new Error(`Unknown skill target id: ${targetId}`);
    }
  }

  if (!targetDefinition) {
    targetDefinition = targetlessTargetDefinition();
  }

  if (
    targetId !== TASK_TARGETLESS_KEY &&
    targetDefinition.skills.length > 0 &&
    !targetDefinition.skills.includes(input.skillId)
  ) {
    throw new Error(`Skill ${input.skillId} cannot target id: ${targetId}`);
  }

  if (!evaluateRequirements(targetDefinition.addRequirements, context)) {
    throw new Error(`Skill target ${targetId} requirements not met`);
  }

  await db
    .insert(skill)
    .values({ id: input.skillId, tavId: input.tavId })
    .onConflictDoNothing();

  const [createdTask] = await db
    .insert(task)
    .values({
      tavId: input.tavId,
      skillId: input.skillId,
      targetId,
    })
    .returning();

  return createdTask;
}

function targetlessTargetDefinition(): TargetDefinition {
  return {
    id: TASK_TARGETLESS_KEY,
    name: "targetless",
    description: "",
    addRequirements: [],
    executeRequirements: [],
    skills: [],
    completionEffect: undefined,
  };
}

async function buildRequirementContext(
  db: DatabaseClient,
  tavId: number,
): Promise<RequirementEvaluationContext> {
  const tavRow = await db.query.tav.findFirst({
    where: eq(tav.id, tavId),
    columns: { abilityScores: true, flags: true },
    with: {
      skills: { columns: { id: true, xpLevel: true } },
      inventory: { columns: { itemId: true, qty: true } },
    },
  });

  const abilityScores =
    tavRow?.abilityScores ?? DEFAULT_TAV_ABILITY_SCORES;

  const rawFlags = (tavRow?.flags ?? []) as unknown;
  const flagArray = Array.isArray(rawFlags) ? (rawFlags as string[]) : [];
  const tavFlags = new Set<string>(flagArray);

  const skillLevels: Record<string, number> = {};
  for (const row of tavRow?.skills ?? []) {
    skillLevels[row.id] = Number(row.xpLevel ?? 0);
  }

  const inventoryTotals: Record<string, number> = {};
  for (const row of tavRow?.inventory ?? []) {
    inventoryTotals[row.itemId] =
      (inventoryTotals[row.itemId] ?? 0) + Number(row.qty ?? 0);
  }

  return {
    abilities: abilityScores,
    skillLevels,
    inventory: inventoryTotals,
    flags: tavFlags,
  };
}

function mergeRequirementContexts(
  base: RequirementEvaluationContext,
  override?: RequirementEvaluationContext,
): RequirementEvaluationContext {
  if (!override) {
    return base;
  }

  const abilities = override.abilities
    ? { ...base.abilities, ...override.abilities }
    : base.abilities;

  const skillLevels = override.skillLevels
    ? { ...base.skillLevels, ...override.skillLevels }
    : base.skillLevels;

  const inventory = override.inventory
    ? mergeInventory(base.inventory, override.inventory)
    : base.inventory;

  const flags = mergeIterables(base.flags, override.flags);

  const customChecks = override.customChecks
    ? { ...base.customChecks, ...override.customChecks }
    : base.customChecks;

  const resolveCustom = override.resolveCustom ?? base.resolveCustom;

  return {
    abilities,
    skillLevels,
    inventory,
    flags,
    customChecks,
    resolveCustom,
  };
}

function mergeInventory(
  base: RequirementEvaluationContext["inventory"],
  override: RequirementEvaluationContext["inventory"],
): RequirementEvaluationContext["inventory"] {
  if (!base) {
    return override;
  }

  if (!override) {
    return base;
  }

  if (base instanceof Map || override instanceof Map) {
    const result = new Map<string, number>();
    if (base instanceof Map) {
      for (const [key, value] of base.entries()) {
        result.set(key, value);
      }
    } else {
      for (const key of Object.keys(base)) {
        result.set(key, base[key]!);
      }
    }

    const applyOverride = (key: string, value: number) => {
      result.set(key, (result.get(key) ?? 0) + value);
    };

    if (override instanceof Map) {
      for (const [key, value] of override.entries()) {
        applyOverride(key, value);
      }
    } else {
      for (const key of Object.keys(override)) {
        applyOverride(key, override[key]!);
      }
    }

    return result;
  }

  const result: Record<string, number> = { ...base };
  for (const key of Object.keys(override)) {
    result[key] = (result[key] ?? 0) + override[key]!;
  }
  return result;
}

function mergeIterables(
  base: RequirementEvaluationContext["flags"],
  override: RequirementEvaluationContext["flags"],
) {
  if (!base && !override) {
    return undefined;
  }

  const result = new Set<string>();
  const addEntries = (iterable?: Iterable<string>) => {
    if (!iterable) {
      return;
    }
    for (const entry of iterable) {
      result.add(entry);
    }
  };

  addEntries(base);
  addEntries(override);

  return result;
}

export async function loadRequirementContext(
  db: DatabaseClient,
  tavId: number,
): Promise<RequirementEvaluationContext> {
  return buildRequirementContext(db, tavId);
}

export async function canExecuteTask(
  db: DatabaseClient,
  input: CanExecuteTaskInput,
): Promise<boolean> {
  const skillDefinition = SKILL_DEFINITIONS.find((definition) => {
    return definition.id === input.skillId;
  });

  if (!skillDefinition) {
    throw new Error(`Unknown skill id: ${input.skillId}`);
  }

  const targetId = input.targetId ?? TASK_TARGETLESS_KEY;

  const isAllowedTarget = skillDefinition.targetIds.includes(targetId);

  if (!isAllowedTarget) {
    throw new Error(`Skill ${input.skillId} cannot target id: ${targetId}`);
  }

  const baseContext = await buildRequirementContext(db, input.tavId);
  const context = mergeRequirementContexts(baseContext, input.context);

  if (!evaluateRequirements(skillDefinition.executeRequirements, context)) {
    return false;
  }

  let targetDefinition = TARGET_DEFINITIONS.find((definition) => {
    return definition.id === targetId;
  });

  if (!targetDefinition) {
    targetDefinition = targetlessTargetDefinition();
  }

  if (
    targetId !== TASK_TARGETLESS_KEY &&
    targetDefinition.skills.length > 0 &&
    !targetDefinition.skills.includes(input.skillId)
  ) {
    return false;
  }

  return evaluateRequirements(targetDefinition.executeRequirements, context);
}
