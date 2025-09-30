import { Hono } from "hono";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { z } from "zod";

import * as schema from "../db/schema.js";
import {
  applyInventoryDelta,
  listInventory,
  moveInventoryItem,
} from "../lib/inventory.js";
import { jsonError, jsonOk, parseJson, parseParamId } from "./util.js";

export function inventoryRoutes(db: PgliteDatabase<typeof schema>) {
  const app = new Hono();

  // List inventory for a tav
  app.get("/", async (c) => {
    const p = parseParamId(c, "tavId");
    if ("error" in p) return p.error;
    const rows = await listInventory(db, p.id);
    return jsonOk(c, rows);
  });

  // Add items: { itemId, qty?=1 }
  app.post("/add", async (c) => {
    const p = parseParamId(c, "tavId");
    if ("error" in p) return p.error;
    const bodySchema = z.object({
      itemId: z.string().min(1),
      qty: z.coerce.number().int().min(1).default(1),
    });
    const parsed = await parseJson(c, bodySchema);
    if ("error" in parsed) return parsed.error;
    const { itemId, qty } = parsed.data;
    await applyInventoryDelta(
      db,
      p.id,
      { [itemId]: qty },
      { strict: true },
    );
    const rows = await listInventory(db, p.id);
    return jsonOk(c, rows, 201);
  });

  // Remove items: { itemId, qty?=1, strict?=true }
  app.post("/remove", async (c) => {
    const p = parseParamId(c, "tavId");
    if ("error" in p) return p.error;
    const bodySchema = z.object({
      itemId: z.string().min(1),
      qty: z.coerce.number().int().min(1).default(1),
      strict: z.coerce.boolean().default(true),
    });
    const parsed = await parseJson(c, bodySchema);
    if ("error" in parsed) return parsed.error;
    const { itemId, qty, strict } = parsed.data;
    try {
      await applyInventoryDelta(
        db,
        p.id,
        { [itemId]: -qty },
        { strict },
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonError(c, message, 400, "inventory_error");
    }
    const rows = await listInventory(db, p.id);
    return jsonOk(c, rows);
  });

  // Move/swap/merge stacks between slots: { fromSlot, toSlot }
  app.post("/move", async (c) => {
    const p = parseParamId(c, "tavId");
    if ("error" in p) return p.error;
    const bodySchema = z.object({
      fromSlot: z.coerce.number().int().min(0),
      toSlot: z.coerce.number().int().min(0),
    });
    const parsed = await parseJson(c, bodySchema);
    if ("error" in parsed) return parsed.error;
    try {
      await moveInventoryItem(
        db,
        p.id,
        parsed.data.fromSlot,
        parsed.data.toSlot,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonError(c, message, 400, "inventory_error");
    }
    const rows = await listInventory(db, p.id);
    return jsonOk(c, rows);
  });

  return app;
}
