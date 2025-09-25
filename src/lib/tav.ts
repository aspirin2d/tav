import { eq } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";

import {
  DEFAULT_TAV_ABILITY_SCORES,
  DEFAULT_SCHEDULE_BLOCKS,
  SKILL_DEFINITIONS,
  TARGET_DEFINITIONS,
  SKILL_LEVEL_THRESHOLDS,
  TAV_LEVEL_THRESHOLDS,
  computeLevel,
} from "../config.js";

import * as schema from "../db/schema.js";
import {
  evaluateRequirements,
  skill,
  task,
  TASK_TARGETLESS_KEY,
  tav,
  schedule,
  type RequirementEvaluationContext,
  type TargetDefinition,
} from "../db/schema.js";

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
  priority?: number; // 1..9, default 5
  context?: RequirementEvaluationContext;
};

export async function createTav(
  db: DatabaseClient,
  input: CreateTavInput,
): Promise<TavRecord> {
  const scheduleId = await ensureDefaultSchedule(db);

  const [created] = await db
    .insert(tav)
    .values({
      name: input.name,
      abilityScores: DEFAULT_TAV_ABILITY_SCORES,
      flags: [],
      scheduleId,
    })
    .returning();
  return created;
}

async function ensureDefaultSchedule(db: DatabaseClient): Promise<number | null> {
  // Prefer an existing schedule named "default"; otherwise create an all-work schedule.
  const [existing] = await db
    .select()
    .from(schedule)
    .where(eq(schedule.name, "default"))
    .limit(1);

  if (existing) {
    return existing.id as number;
  }

  const blocks = DEFAULT_SCHEDULE_BLOCKS;
  const [created] = await db
    .insert(schedule)
    .values({ name: "default", description: "Configured default schedule", blocks })
    .returning();

  return (created as any).id as number;
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
      schedule: true,
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
      ...(input.priority !== undefined
        ? { priority: validatePriority(input.priority) }
        : {}),
    })
    .returning();

  return createdTask;
}

function validatePriority(priority: number): number {
  if (!Number.isInteger(priority)) {
    throw new Error("Task priority must be an integer");
  }
  if (priority < 1 || priority > 9) {
    throw new Error("Task priority must be between 1 and 9");
  }
  return priority;
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
    columns: { abilityScores: true, flags: true, xp: true },
    with: {
      skills: { columns: { id: true, xp: true } },
      inventory: { columns: { itemId: true, qty: true } },
    },
  });

  const abilityScores = tavRow?.abilityScores ?? DEFAULT_TAV_ABILITY_SCORES;

  const rawFlags = (tavRow?.flags ?? []) as unknown;
  const flagArray = Array.isArray(rawFlags) ? (rawFlags as string[]) : [];
  const tavFlags = new Set<string>(flagArray);

  const skillLevels: Record<string, number> = {};
  for (const row of tavRow?.skills ?? []) {
    const xp = Number((row as any).xp ?? 0);
    skillLevels[row.id] = computeLevel(xp, SKILL_LEVEL_THRESHOLDS);
  }

  const inventoryTotals: Record<string, number> = {};
  for (const row of tavRow?.inventory ?? []) {
    inventoryTotals[row.itemId] =
      (inventoryTotals[row.itemId] ?? 0) + Number(row.qty ?? 0);
  }

  return {
    abilities: abilityScores,
    tavLevel: computeLevel(
      Number((tavRow as any)?.xp ?? 0),
      TAV_LEVEL_THRESHOLDS,
    ),
    skillLevels,
    inventory: inventoryTotals,
    flags: tavFlags,
  };
}

export type MergeRequirementContextOptions = {
  /** If true, treat override.inventory values as subtractive instead of additive. Default: false. */
  subtractInventory?: boolean;
};

export function mergeRequirementContexts(
  base: RequirementEvaluationContext,
  override?: RequirementEvaluationContext,
  options?: MergeRequirementContextOptions,
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
    ? mergeInventory(base.inventory, override.inventory, options)
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
  options?: MergeRequirementContextOptions,
): RequirementEvaluationContext["inventory"] {
  const baseMap = normalizeInventory(base);
  const overrideMap = normalizeInventory(override);

  /* c8 ignore next */
  if (baseMap.size === 0 && overrideMap.size === 0) {
    return undefined;
  }

  const sign = options?.subtractInventory ? -1 : 1;
  for (const [key, value] of overrideMap.entries()) {
    baseMap.set(key, (baseMap.get(key) ?? 0) + sign * value);
  }

  const result: Record<string, number> = {};
  for (const [key, value] of baseMap.entries()) {
    result[key] = value;
  }
  return result;
}

function normalizeInventory(
  inventory: RequirementEvaluationContext["inventory"],
): Map<string, number> {
  const result = new Map<string, number>();

  if (!inventory) {
    return result;
  }

  if (inventory instanceof Map) {
    for (const [key, value] of inventory.entries()) {
      result.set(key, Number(value ?? 0));
    }
    return result;
  }

  for (const key of Object.keys(inventory)) {
    result.set(key, Number(inventory[key] ?? 0));
  }

  return result;
}

function mergeIterables(
  base: RequirementEvaluationContext["flags"],
  override: RequirementEvaluationContext["flags"],
) {
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

  return result.size > 0 ? result : undefined;
}

export async function loadRequirementContext(
  db: DatabaseClient,
  tavId: number,
): Promise<RequirementEvaluationContext> {
  return buildRequirementContext(db, tavId);
}
