import { Hono } from "hono";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { z } from "zod";

import * as schema from "../db/schema.js";
import { tav as tavTable } from "../db/schema.js";
import { createTav, deleteTav, getTavById } from "../lib/tav.js";
import {
  jsonCreated,
  jsonError,
  jsonOk,
  parseJson,
  parseParamId,
} from "./_util.js";

export function tavRoutes(db: PgliteDatabase<typeof schema>) {
  const app = new Hono();

  // List tavs (basic info)
  app.get("/", async (c) => {
    const rows = await db
      .select({
        id: tavTable.id,
        name: tavTable.name,
        updatedAt: tavTable.updatedAt,
      })
      .from(tavTable)
      .orderBy(tavTable.id);
    return jsonOk(c, rows);
  });

  // Create tav
  app.post("/", async (c) => {
    const schema = z.object({ name: z.string().min(1) });
    const parsed = await parseJson(c, schema);
    if ("error" in parsed) return parsed.error;
    const created = await createTav(db as any, {
      name: parsed.data.name.trim(),
    });
    return jsonCreated(c, created);
  });

  // Read tav by id
  app.get("/:id", async (c) => {
    const p = parseParamId(c, "id");
    if ("error" in p) return p.error;
    const row = await getTavById(db as any, p.id);
    if (!row) return jsonError(c, "not found", 404, "not_found");
    return jsonOk(c, row);
  });

  // Update tav (name, scheduleId)
  app.put("/:id", async (c) => {
    const p = parseParamId(c, "id");
    if ("error" in p) return p.error;

    const bodySchema = z
      .object({
        name: z.string().min(1).optional(),
        scheduleId: z.number().int().nonnegative().nullable().optional(),
      })
      .refine((v) => Object.keys(v).length > 0, {
        message: "no fields to update",
        path: ["_root"],
      });
    const parsed = await parseJson(c, bodySchema);
    if ("error" in parsed) return parsed.error;

    const update: Partial<typeof tavTable.$inferInsert> = {};
    if (parsed.data.name !== undefined) update.name = parsed.data.name.trim();
    if (parsed.data.scheduleId !== undefined)
      update.scheduleId = parsed.data.scheduleId as any;

    const [updated] = await db
      .update(tavTable)
      .set(update as any)
      .where(eq(tavTable.id, p.id))
      .returning();
    if (!updated) return jsonError(c, "not found", 404, "not_found");
    return jsonOk(c, updated);
  });

  // Delete tav
  app.delete("/:id", async (c) => {
    const p = parseParamId(c, "id");
    if ("error" in p) return p.error;
    const deleted = await deleteTav(db as any, p.id);
    if (!deleted) return jsonError(c, "not found", 404, "not_found");
    return jsonOk(c, { ok: true });
  });

  return app;
}
