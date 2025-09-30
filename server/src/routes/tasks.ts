import { Hono } from "hono";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { z } from "zod";

import * as schema from "../db/schema.js";
import { addTask } from "../lib/tav.js";
import { tickTask } from "../lib/task.js";
import { jsonError, jsonOk, parseJson, parseParamId } from "./util.js";

export function taskRoutes(db: PgliteDatabase<typeof schema>) {
  const app = new Hono();

  // List tasks
  app.get("/", async (c) => {
    const p = parseParamId(c, "tavId");
    if ("error" in p) return p.error;
    const rows = await db.query.task.findMany({
      where: (t, { eq }) => eq(t.tavId, p.id),
      orderBy: (t, { desc, asc }) => [
        asc(t.status),
        desc(t.priority),
        asc(t.createdAt),
      ],
    });
    return jsonOk(c, rows);
  });

  // Add a task: { skillId, targetId?, priority? }
  app.post("/", async (c) => {
    const p = parseParamId(c, "tavId");
    if ("error" in p) return p.error;
    const bodySchema = z.object({
      skillId: z.string().min(1),
      targetId: z.string().min(1).nullable().optional(),
      priority: z.coerce.number().int().min(1).max(9).optional(),
    });
    const parsed = await parseJson(c, bodySchema);
    if ("error" in parsed) return parsed.error;
    try {
      const created = await addTask(db, {
        tavId: p.id,
        skillId: parsed.data.skillId,
        targetId: parsed.data.targetId ?? undefined,
        priority: parsed.data.priority,
      });
      return jsonOk(c, created, 201);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonError(c, message, 400, "task_error");
    }
  });

  // Tick tasks (no input): GET
  app.get("/tick", async (c) => {
    const p = parseParamId(c, "tavId");
    if ("error" in p) return p.error;
    try {
      const result = await tickTask(db, { tavId: p.id });
      return jsonOk(c, result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonError(c, message, 400, "task_error");
    }
  });

  return app;
}
