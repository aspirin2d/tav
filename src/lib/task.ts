import { and, eq, sql } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";

import {
  DEFAULT_TAV_ABILITY_SCORES,
  MAX_LOOP_LIMIT,
  SKILL_DEFINITIONS,
  TARGET_DEFINITIONS,
  SKILL_LEVEL_THRESHOLDS,
  TAV_LEVEL_THRESHOLDS,
  computeLevel,
} from "../config.js";
import * as schema from "../db/schema.js";
import {
  skill,
  task,
  tav,
  type CompletionEffect,
  type RequirementEvaluationContext,
} from "../db/schema.js";
import { applyInventoryDelta, type InventoryDelta } from "./inventory.js";

export type DatabaseClient = PgliteDatabase<typeof schema>;

export type TaskKey = {
  tavId: number;
  skillId: string;
  targetId: string;
};

export type TickOptions = {
  tavId: number;
  now?: Date;
  lastTickAt?: Date;
  context?: RequirementEvaluationContext;
};

export type TickResult = {
  started: TaskKey[];
  completed: TaskKey[];
  failed: TaskKey[];
};

type TaskCompletionEffect = {
  tavXp?: number;
  skillXp?: number;
  inventory?: InventoryDelta;
};

type TaskRow = typeof task.$inferSelect;

const SKILL_DEFINITION_MAP = new Map(
  SKILL_DEFINITIONS.map((definition) => [definition.id, definition] as const),
);

const TARGET_DEFINITION_MAP = new Map(
  TARGET_DEFINITIONS.map((definition) => [definition.id, definition] as const),
);

/**
 * Advances a tav's work clock and schedules tasks.
 *
 * Algorithm (single call may iterate):
 * - Snapshot tav relations once (skills, tasks, inventory, flags).
 * - Establish a time cursor from `lastTickAt` or tav `updatedAt`.
 * - While cursor <= `now` and under `MAX_LOOP_LIMIT`:
 *   - If an executing task's deadline <= now, aggregate its completion effects,
 *     update the in-memory requirement context and mark it completed in results,
 *     advance the cursor to the deadline, then continue.
 *   - Else choose the best eligible pending task (priority desc, createdAt asc),
 *     mark it executing at the cursor, then continue.
 *   - If none are eligible, break.
 * - Commit XP, inventory, and task state atomically; bump tav `updatedAt` to now.
 * - When `tavId` is omitted, auto-select a tav with work (pending/executing).
 */
export async function tickTask(
  db: DatabaseClient,
  options: TickOptions,
): Promise<TickResult> {
  const now = options.now ?? new Date();
  const tavId = options.tavId;

  // Snapshot (read-only)
  const tavRow = await db.query.tav.findFirst({
    with: {
      skills: true,
      tasks: true,
      inventory: true,
    },
    where: eq(tav.id, tavId),
  });

  if (!tavRow) throw new Error("character not found");

  // Pre-load requirement base context once (stable snapshot)
  const abilityScores = tavRow.abilityScores ?? DEFAULT_TAV_ABILITY_SCORES;

  const rawFlags = (tavRow.flags ?? []) as unknown;
  const flagArray = Array.isArray(rawFlags) ? (rawFlags as string[]) : [];
  const tavFlags = new Set<string>(flagArray);

  const skillLevels: Record<string, number> = {};
  const skillXpTotals: Record<string, number> = {};
  for (const row of tavRow.skills ?? []) {
    const xp = Number((row as any).xp ?? 0);
    skillXpTotals[row.id] = xp;
    skillLevels[row.id] = computeLevel(xp, SKILL_LEVEL_THRESHOLDS);
  }

  const inventoryTotals: Record<string, number> = {};
  for (const row of tavRow.inventory ?? []) {
    inventoryTotals[row.itemId] =
      (inventoryTotals[row.itemId] ?? 0) + Number(row.qty ?? 0);
  }

  let requirementContext: RequirementEvaluationContext = {
    abilities: abilityScores,
    tavLevel: computeLevel(Number(tavRow.xp ?? 0), TAV_LEVEL_THRESHOLDS),
    skillLevels,
    inventory: inventoryTotals,
    flags: tavFlags,
  };

  requirementContext = options.context
    ? {
        ...requirementContext,
        ...options.context,
        // Merge subparts more precisely if you want; baseContext is usually sufficient
      }
    : requirementContext;

  const cursorStart = options.lastTickAt ?? tavRow?.updatedAt ?? now;
  let cursor = new Date(cursorStart.getTime());

  // empty result
  const result = emptyResult();
  const context = {
    tavXpDelta: 0,
    skillXpDelta: {} as Record<string, number>,
    inventoryDelta: {} as Record<string, number>,
  };

  // Virtual XP trackers to recompute levels within the current window
  let virtualTavXp = Number(tavRow.xp ?? 0);
  const virtualSkillXp: Record<string, number> = { ...skillXpTotals };

  let loopCount = 0;

  // loop for advancing time cursor
  while (cursor <= now && loopCount < MAX_LOOP_LIMIT) {
    // pending tasks
    const pending = tavRow.tasks.filter((t) => t.status === "pending");

    // executing task
    const executing = tavRow.tasks.find((t) => t.status === "executing");

    // A) If we have an executing task, try to complete it if deadline <= now
    if (executing) {
      const skill = getSkillDefinition(executing.skillId);
      if (!skill) throw new Error("skill not found: " + executing.skillId);

      const startedAt = executing.startedAt;
      if (!startedAt)
        throw new Error("startedAt is not set for task:" + taskKey(executing));
      const deadline = new Date(startedAt.getTime() + skill.duration);

      if (now < deadline) {
        // cannot finish within window; stop due to time
        break;
      }

      // complete one cycle at deadline; advance cursor there
      cursor = deadline;

      // Completion effects (aggregate only)
      const effect = resolveCompletionEffect(
        executing.skillId,
        executing.targetId,
      );
      if (effect) {
        if (effect.tavXp) {
          context.tavXpDelta += effect.tavXp;
          virtualTavXp += effect.tavXp;
          requirementContext.tavLevel = computeLevel(
            virtualTavXp,
            TAV_LEVEL_THRESHOLDS,
          );
        }
        if (effect.skillXp) {
          context.skillXpDelta[executing.skillId] =
            (context.skillXpDelta[executing.skillId] ?? 0) + effect.skillXp;
          virtualSkillXp[executing.skillId] =
            (virtualSkillXp[executing.skillId] ?? 0) + effect.skillXp;
          requirementContext.skillLevels![executing.skillId] = computeLevel(
            virtualSkillXp[executing.skillId]!,
            SKILL_LEVEL_THRESHOLDS,
          );
        }
        if (effect.inventory) {
          for (const [itemId, delta] of Object.entries(effect.inventory)) {
            const d = delta ?? 0;
            context.inventoryDelta[itemId] =
              (context.inventoryDelta[itemId] ?? 0) + d;

            // update requirement context to reflect newly gained/consumed items
            requirementContext.inventory = addToInventoryContext(
              requirementContext.inventory,
              itemId,
              d,
            );
          }
        }
      }

      // task completion → move back to pending in memory
      executing.status = "pending";

      // push the TaskKey into result
      result.completed.push(taskKey(executing));

      loopCount += 1;
      continue;
    }

    // B) No executing → pick best eligible pending
    // Filter eligible pending using canExecuteTask
    // We evaluate on the stable base context (plus optional user-provided overrides).
    const eligible: { row: TaskRow; priority: number; createdAtMs: number }[] =
      [];

    for (const row of pending) {
      const skillDef = getSkillDefinition(row.skillId);
      if (!skillDef) continue;

      const targetId = row.targetId ?? schema.TASK_TARGETLESS_KEY;
      const isAllowedTarget = skillDef.targetIds.includes(targetId);

      if (!isAllowedTarget) {
        throw new Error(`skill ${row.skillId} cannot target id: ${targetId}`);
      }

      const targetDef = getTargetDefinition(row.targetId);

      if (
        !schema.evaluateRequirements(
          skillDef.executeRequirements,
          requirementContext,
        )
      )
        continue;

      if (
        targetDef &&
        !schema.evaluateRequirements(
          targetDef.executeRequirements,
          requirementContext,
        )
      )
        continue;

      eligible.push({
        row,
        priority: skillDef.priority,
        createdAtMs: row.createdAt?.getTime() ?? 0,
      });
    }

    if (eligible.length === 0) {
      // nothing to do
      break;
    }

    // pick best by priority desc, createdAt asc
    eligible.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.createdAtMs - b.createdAtMs;
    });

    const pick = eligible[0]!.row;
    pick.status = "executing";
    pick.startedAt = new Date(cursor);
    pick.endedAt = null;

    result.started.push(taskKey(pick));
    // Loop continues; next iteration will try to complete if deadline ≤ now
  }

  // Write changes to DB
  await db.transaction(async (tx) => {
    // write xp delta
    if (context.tavXpDelta !== 0) {
      await tx
        .update(tav)
        .set({ xp: sql`${tav.xp} + ${context.tavXpDelta}` })
        .where(eq(tav.id, tavId));
    }

    // write skill xp delta
    for (const skillId in context.skillXpDelta) {
      const delta = context.skillXpDelta[skillId];
      if (delta === 0) continue;
      await tx
        .update(skill)
        .set({ xp: sql`${skill.xp} + ${delta}` })
        .where(and(eq(skill.tavId, tavId), eq(skill.id, skillId)));
    }

    // write inventory delta
    await applyInventoryDelta(
      tx as unknown as DatabaseClient,
      tavId,
      context.inventoryDelta,
      {
        strict: true,
      },
    );

    // update tasks
    for (const item of tavRow.tasks) {
      await tx
        .update(task)

        .set({
          status: item.status,
          startedAt: item.startedAt,
          endedAt: item.endedAt,
        })
        .where(
          and(
            eq(task.tavId, item.tavId),
            eq(task.skillId, item.skillId),
            eq(task.targetId, item.targetId),
          ),
        );
    }

    // Advance tav clock to now to make the window idempotent
    await tx.update(tav).set({ updatedAt: now }).where(eq(tav.id, tavId));
  });

  return result;
}

function emptyResult(): TickResult {
  return { started: [], completed: [], failed: [] };
}

function getSkillDefinition(skillId: string) {
  return SKILL_DEFINITION_MAP.get(skillId) ?? null;
}

function getTargetDefinition(targetId: string) {
  return TARGET_DEFINITION_MAP.get(targetId) ?? null;
}

function addToInventoryContext(
  inventory: RequirementEvaluationContext["inventory"],
  itemId: string,
  delta: number,
): RequirementEvaluationContext["inventory"] {
  if (!inventory) {
    return { [itemId]: delta };
  }

  inventory[itemId] = (inventory[itemId] ?? 0) + delta;
  return inventory;
}

function resolveCompletionEffect(
  skillId: string,
  targetId: string,
): TaskCompletionEffect | null {
  const skillDefinition = getSkillDefinition(skillId);
  const targetDefinition = getTargetDefinition(targetId);

  return mergeCompletionEffects(
    coerceEffect(skillDefinition?.completionEffect),
    coerceEffect(
      skillDefinition?.completionEffect?.targetOverrides?.[targetId],
    ),
    coerceEffect(targetDefinition?.completionEffect),
  );
}

type CompletionEffectOverride = NonNullable<
  CompletionEffect["targetOverrides"]
>[string];

type CompletionEffectLike =
  | CompletionEffect
  | CompletionEffectOverride
  | TaskCompletionEffect
  | null
  | undefined;

function coerceEffect(
  effect: CompletionEffectLike,
): TaskCompletionEffect | null {
  if (!effect) {
    return null;
  }

  const result: TaskCompletionEffect = {};

  if (typeof effect.tavXp === "number") {
    result.tavXp = effect.tavXp;
  }

  if (typeof effect.skillXp === "number") {
    result.skillXp = effect.skillXp;
  }

  if (effect.inventory) {
    const entries = Object.entries(effect.inventory).filter(
      ([, qty]) => qty !== 0,
    );
    if (entries.length > 0) {
      result.inventory = Object.fromEntries(entries);
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

function mergeCompletionEffects(
  ...effects: Array<TaskCompletionEffect | null | undefined>
): TaskCompletionEffect | null {
  let tavXpTotal = 0;
  let skillXpTotal = 0;
  let sawTavXp = false;
  let sawSkillXp = false;

  const inventoryTotals: InventoryDelta = {};
  let sawInventory = false;

  for (const effect of effects) {
    if (!effect) {
      continue;
    }

    if (typeof effect.tavXp === "number") {
      tavXpTotal += effect.tavXp;
      sawTavXp = true;
    }

    if (typeof effect.skillXp === "number") {
      skillXpTotal += effect.skillXp;
      sawSkillXp = true;
    }

    if (effect.inventory) {
      sawInventory = true;
      for (const [itemId, delta] of Object.entries(effect.inventory)) {
        if (!delta) {
          continue;
        }
        inventoryTotals[itemId] = (inventoryTotals[itemId] ?? 0) + delta;
      }
    }
  }

  const result: TaskCompletionEffect = {};

  if (sawTavXp && tavXpTotal !== 0) {
    result.tavXp = tavXpTotal;
  }

  if (sawSkillXp && skillXpTotal !== 0) {
    result.skillXp = skillXpTotal;
  }

  if (sawInventory) {
    const cleaned = Object.fromEntries(
      Object.entries(inventoryTotals).filter(([, value]) => value !== 0),
    );
    if (Object.keys(cleaned).length > 0) {
      result.inventory = cleaned;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

function taskKey(record: {
  tavId: number;
  skillId: string;
  targetId: string;
}): TaskKey {
  return {
    tavId: record.tavId,
    skillId: record.skillId,
    targetId: record.targetId,
  };
}

// Expose selected helpers for tests
export { addToInventoryContext, mergeCompletionEffects };
