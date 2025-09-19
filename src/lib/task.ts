import { and, eq, or, sql } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";

import { SKILL_DEFINITIONS, TARGET_DEFINITIONS } from "../config.js";
import {
  inventory,
  skill,
  task,
  tav,
  type CompletionEffect,
  type RequirementEvaluationContext,
} from "../db/schema.js";
import { canExecuteTask, loadRequirementContext } from "../db/tav.js";
import * as schema from "../db/schema.js";

export type DatabaseClient = PgliteDatabase<typeof schema>;

export type TaskKey = {
  tavId: number;
  skillId: string;
  targetId: string;
};

export type TickOptions = {
  tavId?: number;
  now?: Date;
  lastTickAt?: Date;
  context?: RequirementEvaluationContext;
};

export type TickResult = {
  started: TaskKey[];
  completed: TaskKey[];
  failed: TaskKey[];
};

type InventoryDelta = Record<string, number>;

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
 * Performs a single scheduling pass: finalize any executing task and start the
 * next eligible pending task for the selected tav.
 */
export async function tickTask(
  db: DatabaseClient,
  options: TickOptions = {},
): Promise<TickResult> {
  const now = options.now ?? new Date();
  const tavId = await resolveTavId(db, options.tavId);

  if (tavId === null) {
    return emptyResult();
  }

  return db.transaction(async (tx) => {
    const result = emptyResult();

    const lastTick = await resolveLastTickTimestamp(
      tx,
      tavId,
      now,
      options.lastTickAt,
    );

    const executing = await getExecutingTask(tx, tavId);
    const stillRunning = await handleExecutingTask(
      tx,
      executing,
      now,
      lastTick,
      result,
    );

    if (!stillRunning) {
      await startBestPendingTask(tx, tavId, now, options.context, result);
    }

    await tx
      .update(schema.tav)
      .set({ updatedAt: now })
      .where(eq(schema.tav.id, tavId));

    return result;
  });
}

function emptyResult(): TickResult {
  return { started: [], completed: [], failed: [] };
}

async function resolveLastTickTimestamp(
  db: DatabaseClient,
  tavId: number,
  now: Date,
  explicit?: Date,
): Promise<Date> {
  if (explicit) {
    return explicit;
  }

  const row = await db
    .select({ updatedAt: schema.tav.updatedAt })
    .from(schema.tav)
    .where(eq(schema.tav.id, tavId))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  return row?.updatedAt ?? now;
}

async function getExecutingTask(db: DatabaseClient, tavId: number) {
  return db
    .query.task.findFirst({
      where: (tasks, { and: andOp, eq: eqOp }) =>
        andOp(eqOp(tasks.tavId, tavId), eqOp(tasks.status, "executing")),
    })
    .then((row) => row ?? null);
}

async function handleExecutingTask(
  db: DatabaseClient,
  executing: TaskRow | null,
  now: Date,
  lastTick: Date,
  result: TickResult,
): Promise<boolean> {
  if (!executing) {
    return false;
  }

  const definition = getSkillDefinition(executing.skillId);

  if (!definition) {
    await markTaskFailed(db, executing, now, result);
    return false;
  }

  const deadline = new Date(lastTick.getTime() + definition.duration);

  if (now >= deadline) {
    await moveTaskToPending(db, executing, now, result);
    return false;
  }

  return true;
}

function getSkillDefinition(skillId: string) {
  return SKILL_DEFINITION_MAP.get(skillId) ?? null;
}

function getTargetDefinition(targetId: string) {
  return TARGET_DEFINITION_MAP.get(targetId) ?? null;
}

async function markTaskFailed(
  db: DatabaseClient,
  executing: TaskRow,
  now: Date,
  result: TickResult,
) {
  // Drop tasks whose skill definition no longer exists so they do not block.
  const failedRows = await db
    .update(task)
    .set({ status: "failed", endedAt: now })
    .where(
      and(
        eq(task.tavId, executing.tavId),
        eq(task.skillId, executing.skillId),
        eq(task.targetId, executing.targetId),
      ),
    )
    .returning();

  if (failedRows.length > 0) {
    result.failed.push(taskKey(executing));
  }
}

function resolveCompletionEffect(
  skillId: string,
  targetId: string,
): TaskCompletionEffect | null {
  const skillDefinition = getSkillDefinition(skillId);
  const targetDefinition = getTargetDefinition(targetId);

  return mergeCompletionEffects(
    coerceEffect(skillDefinition?.completionEffect),
    coerceEffect(skillDefinition?.completionEffect?.targetOverrides?.[targetId]),
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

function coerceEffect(effect: CompletionEffectLike): TaskCompletionEffect | null {
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
    const entries = Object.entries(effect.inventory).filter(([, qty]) => qty !== 0);
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
    for (const key of Object.keys(inventoryTotals)) {
      if (inventoryTotals[key] === 0) {
        delete inventoryTotals[key];
      }
    }
    if (Object.keys(inventoryTotals).length > 0) {
      result.inventory = inventoryTotals;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

async function applyTaskCompletionEffects(
  db: DatabaseClient,
  executing: TaskRow,
) {
  const effect = resolveCompletionEffect(executing.skillId, executing.targetId);

  if (!effect) {
    return;
  }

  // Apply rewards atomically alongside task state transitions.
  const tavXp = effect.tavXp ?? 0;
  if (tavXp !== 0) {
    await db
      .update(tav)
      .set({ xp: sql`${tav.xp} + ${tavXp}` })
      .where(eq(tav.id, executing.tavId));
  }

  const skillXp = effect.skillXp ?? 0;
  if (skillXp !== 0) {
    await db
      .update(skill)
      .set({ xp: sql`${skill.xp} + ${skillXp}` })
      .where(
        and(
          eq(skill.tavId, executing.tavId),
          eq(skill.id, executing.skillId),
        ),
      );
  }

  if (effect.inventory) {
    await applyInventoryDelta(db, executing.tavId, effect.inventory);
  }
}

async function applyInventoryDelta(
  db: DatabaseClient,
  tavId: number,
  deltas: InventoryDelta,
) {
  const entries = Object.entries(deltas).filter(([, value]) => value !== 0);

  if (entries.length === 0) {
    return;
  }

  const existing = await db
    .select({
      slot: inventory.slot,
      itemId: inventory.itemId,
      qty: inventory.qty,
    })
    .from(inventory)
    .where(eq(inventory.tavId, tavId));

  type Snapshot = { slot: number; qty: number };

  const state = new Map<string, Snapshot>();
  let maxSlot = -1;

  for (const row of existing) {
    const slot = Number(row.slot ?? 0);
    const qty = Number(row.qty ?? 0);
    state.set(row.itemId, { slot, qty });
    if (slot > maxSlot) {
      maxSlot = slot;
    }
  }

  let nextSlot = maxSlot + 1;

  for (const [itemId, rawChange] of entries) {
    const change = Math.trunc(Number(rawChange));

    if (!Number.isFinite(change) || change === 0) {
      continue;
    }

    const snapshot = state.get(itemId);

    // Grow stacks when possible, otherwise consume an open slot for new items.
    if (change > 0) {
      if (snapshot) {
        const newQty = snapshot.qty + change;
        await db
          .update(inventory)
          .set({ qty: newQty })
          .where(
            and(
              eq(inventory.tavId, tavId),
              eq(inventory.slot, snapshot.slot),
            ),
          );
        snapshot.qty = newQty;
      } else {
        const slot = nextSlot++;
        await db.insert(inventory).values({
          tavId,
          slot,
          itemId,
          qty: change,
        });
        state.set(itemId, { slot, qty: change });
      }
      continue;
    }

    if (!snapshot) {
      continue;
    }

    const newQty = snapshot.qty + change;

    // Drop depleted stacks entirely so they stop occupying slots.
    if (newQty > 0) {
      await db
        .update(inventory)
        .set({ qty: newQty })
        .where(
          and(
            eq(inventory.tavId, tavId),
            eq(inventory.slot, snapshot.slot),
          ),
        );
      snapshot.qty = newQty;
    } else {
      await db
        .delete(inventory)
        .where(
          and(
            eq(inventory.tavId, tavId),
            eq(inventory.slot, snapshot.slot),
          ),
        );
      state.delete(itemId);
    }
  }
}

async function moveTaskToPending(
  db: DatabaseClient,
  executing: TaskRow,
  now: Date,
  result: TickResult,
) {
  // Requeue tasks that exceeded their allotted duration for another attempt.
  const completedRows = await db
    .update(task)
    .set({ status: "pending", startedAt: null, endedAt: now })
    .where(
      and(
        eq(task.tavId, executing.tavId),
        eq(task.skillId, executing.skillId),
        eq(task.targetId, executing.targetId),
      ),
    )
    .returning();

  if (completedRows.length > 0) {
    await applyTaskCompletionEffects(db, executing);
    result.completed.push(taskKey(executing));
  }
}

async function startBestPendingTask(
  db: DatabaseClient,
  tavId: number,
  now: Date,
  context: RequirementEvaluationContext | undefined,
  result: TickResult,
) {
  const pendingTasks = await db.query.task.findMany({
    where: (tasks, { and: andOp, eq: eqOp }) =>
      andOp(eqOp(tasks.tavId, tavId), eqOp(tasks.status, "pending")),
  });

  if (pendingTasks.length === 0) {
    return;
  }

  const baseContext = await loadRequirementContext(db, tavId);

  let best: { row: TaskRow; priority: number; createdAt: number } | null = null;

  for (const row of pendingTasks) {
    const definition = getSkillDefinition(row.skillId);

    if (!definition) {
      continue;
    }

    try {
      const executable = await canExecuteTask(db, {
        tavId,
        skillId: row.skillId,
        targetId: row.targetId,
        context,
        baseContext,
      });

      if (!executable) {
        continue;
      }
    } catch {
      continue;
    }

    const createdAt = row.createdAt?.getTime() ?? 0;

    if (!best) {
      best = { row, priority: definition.priority, createdAt };
      continue;
    }

    if (definition.priority > best.priority) {
      best = { row, priority: definition.priority, createdAt };
      continue;
    }

    if (
      definition.priority === best.priority &&
      createdAt < best.createdAt
    ) {
      best = { row, priority: definition.priority, createdAt };
    }
  }

  if (!best) {
    return;
  }

  const target = best.row;

  const startedRows = await db
    .update(task)
    .set({ status: "executing", startedAt: now, endedAt: null })
    .where(
      and(
        eq(task.tavId, target.tavId),
        eq(task.skillId, target.skillId),
        eq(task.targetId, target.targetId),
        eq(task.status, "pending"),
      ),
    )
    .returning();

  if (startedRows.length > 0) {
    result.started.push(taskKey(target));
  }
}

async function resolveTavId(
  db: DatabaseClient,
  supplied: number | undefined,
): Promise<number | null> {
  // Respect a caller-provided tavId when set.
  if (typeof supplied === "number") {
    return supplied;
  }

  // Otherwise pick any tav that still has work to do.
  const rows = await db
    .select({ tavId: task.tavId })
    .from(task)
    .where(or(eq(task.status, "pending"), eq(task.status, "executing")))
    .limit(1);

  return rows[0]?.tavId ?? null;
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
