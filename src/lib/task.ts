import { and, eq, or } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";

import { SKILL_DEFINITIONS } from "../config.js";
import {
  task,
  type RequirementEvaluationContext,
} from "../db/schema.js";
import { canExecuteTask } from "../db/tav.js";
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

    const tavRow = await tx
      .select({ updatedAt: schema.tav.updatedAt })
      .from(schema.tav)
      .where(eq(schema.tav.id, tavId))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    const lastTick = options.lastTickAt ?? tavRow?.updatedAt ?? now;

    const executing = await tx.query.task.findFirst({
      where: (tasks, { and: andOp, eq: eqOp }) =>
        andOp(eqOp(tasks.tavId, tavId), eqOp(tasks.status, "executing")),
    });

    let hasExecuting = false;

    if (executing) {
      const definition = findSkillDefinition(executing.skillId);

      if (!definition) {
        await markTaskFailed(tx, executing, now, result);
      } else {
        const deadline = new Date(lastTick.getTime() + definition.duration);
        if (now >= deadline) {
          await moveTaskToPending(tx, executing, now, result);
        } else {
          hasExecuting = true;
        }
      }
    }

    if (!hasExecuting) {
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

function findSkillDefinition(skillId: string) {
  return SKILL_DEFINITIONS.find((definition) => definition.id === skillId);
}

async function markTaskFailed(
  db: DatabaseClient,
  executing: typeof task.$inferSelect,
  now: Date,
  result: TickResult,
) {
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

async function moveTaskToPending(
  db: DatabaseClient,
  executing: typeof task.$inferSelect,
  now: Date,
  result: TickResult,
) {
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

  const candidates = [] as Array<{
    row: typeof pendingTasks[number];
    priority: number;
  }>;

  for (const row of pendingTasks) {
    const definition = findSkillDefinition(row.skillId);

    if (!definition) {
      continue;
    }

    try {
      const executable = await canExecuteTask(db, {
        tavId,
        skillId: row.skillId,
        targetId: row.targetId,
        context,
      });

      if (!executable) {
        continue;
      }
    } catch {
      continue;
    }

    candidates.push({ row, priority: definition.priority });
  }

  if (candidates.length === 0) {
    return;
  }

  candidates.sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }

    return a.row.createdAt.getTime() - b.row.createdAt.getTime();
  });

  const chosen = candidates[0].row;

  const startedRows = await db
    .update(task)
    .set({ status: "executing", startedAt: now, endedAt: null })
    .where(
      and(
        eq(task.tavId, chosen.tavId),
        eq(task.skillId, chosen.skillId),
        eq(task.targetId, chosen.targetId),
        eq(task.status, "pending"),
      ),
    )
    .returning();

  if (startedRows.length > 0) {
    result.started.push(taskKey(chosen));
  }
}

async function resolveTavId(
  db: DatabaseClient,
  supplied: number | undefined,
): Promise<number | null> {
  if (typeof supplied === "number") {
    return supplied;
  }

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
