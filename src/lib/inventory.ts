import { and, eq } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";

import { inventory } from "../db/schema.js";
import * as schema from "../db/schema.js";
import { requireItemDefinition } from "./items.js";

export type DatabaseClient = PgliteDatabase<typeof schema>;

export type InventoryRow = typeof inventory.$inferSelect;

export type InventoryTotals = Record<string, number>;

export type InventoryDelta = Record<string, number>;

export type ApplyDeltaOptions = {
  strict?: boolean;
};

export async function moveInventoryItem(
  db: DatabaseClient,
  tavId: number,
  fromSlot: number,
  toSlot: number,
): Promise<void> {
  if (fromSlot < 0 || !Number.isInteger(fromSlot)) {
    throw new Error(`Invalid fromSlot: ${fromSlot}`);
  }
  if (!Number.isInteger(toSlot)) {
    throw new Error(`Invalid toSlot: ${toSlot}`);
  }

  const rows = (await listInventory(db, tavId))
    .map((row) => ({
      slot: Number(row.slot ?? 0),
      itemId: row.itemId,
      qty: Number(row.qty ?? 0),
    }))
    .sort((a, b) => a.slot - b.slot);

  const fromIndex = rows.findIndex((row) => row.slot === fromSlot);

  if (fromIndex === -1) {
    throw new Error(`No inventory item found in slot ${fromSlot}`);
  }

  const from = rows.splice(fromIndex, 1)[0]!;
  const definition = requireItemDefinition(from.itemId);
  const stackLimit = definition.stackLimit ?? Number.MAX_SAFE_INTEGER;

  const clampedTo = Math.max(0, Math.min(toSlot, rows.length));

  if (rows.length === 0) {
    rows.push(from);
  } else if (clampedTo >= rows.length) {
    rows.push(from);
  } else {
    const target = rows[clampedTo]!;
    if (target.itemId === from.itemId) {
      const total = target.qty + from.qty;
      target.qty = Math.min(stackLimit, total);
      const leftover = total - target.qty;
      if (leftover > 0) {
        rows.splice(clampedTo + 1, 0, { ...from, qty: leftover });
      }
    } else {
      rows.splice(clampedTo, 0, from);
    }
  }

  const sanitized = rows.filter((row) => row.qty > 0);

  await db.delete(inventory).where(eq(inventory.tavId, tavId));

  if (sanitized.length === 0) {
    return;
  }

  await db.insert(inventory).values(
    sanitized.map((row, index) => ({
      tavId,
      slot: index,
      itemId: row.itemId,
      qty: row.qty,
    })),
  );
}

export async function listInventory(
  db: DatabaseClient,
  tavId: number,
): Promise<InventoryRow[]> {
  return db.query.inventory.findMany({
    where: (rows, { eq: eqOp }) => eqOp(rows.tavId, tavId),
    orderBy: (rows, { asc }) => [asc(rows.slot)],
  });
}

export async function getInventoryTotals(
  db: DatabaseClient,
  tavId: number,
): Promise<InventoryTotals> {
  const rows = await listInventory(db, tavId);
  const totals: InventoryTotals = {};
  for (const row of rows) {
    totals[row.itemId] = (totals[row.itemId] ?? 0) + Number(row.qty ?? 0);
  }
  return totals;
}

export async function applyInventoryDelta(
  db: DatabaseClient,
  tavId: number,
  deltas: InventoryDelta,
  options: ApplyDeltaOptions = {},
): Promise<void> {
  const entries = Object.entries(deltas).filter(([, value]) => value !== 0);

  if (entries.length === 0) {
    return;
  }

  let existing = await listInventory(db, tavId);

  const stacks = new Map<string, Array<{ slot: number; qty: number }>>();
  let maxSlot = -1;

  for (const row of existing) {
    const slot = Number(row.slot ?? 0);
    const qty = Number(row.qty ?? 0);
    const list = stacks.get(row.itemId) ?? [];
    list.push({ slot, qty });
    stacks.set(row.itemId, list);
    if (slot > maxSlot) {
      maxSlot = slot;
    }
  }

  if (options.strict) {
    const totals = getTotalsFromStacks(stacks);
    for (const [itemId, change] of entries) {
      if (change < 0) {
        const available = totals[itemId] ?? 0;
        if (available + change < 0) {
          throw new Error(`Insufficient quantity for item ${itemId}`);
        }
        totals[itemId] = available + change;
      }
    }
  }

  for (const [itemId, rawChange] of entries) {
    const definition = requireItemDefinition(itemId);
    const stackLimit = definition.stackLimit ?? Number.MAX_SAFE_INTEGER;

    const change = Math.trunc(Number(rawChange));

    /* c8 ignore next */
    if (!Number.isFinite(change) || change === 0) {
      continue;
    }

    const stackList = stacks.get(itemId) ?? [];

    if (change > 0) {
      let remaining = change;

      for (const stack of stackList) {
        if (remaining <= 0) {
          break;
        }
        const capacity = stackLimit - stack.qty;
        if (capacity <= 0) {
          continue;
        }
        const add = Math.min(capacity, remaining);
        await db
          .update(inventory)
          .set({ qty: stack.qty + add })
          .where(
            and(
              eq(inventory.tavId, tavId),
              eq(inventory.slot, stack.slot),
            ),
          );
        stack.qty += add;
        remaining -= add;
      }

      while (remaining > 0) {
        const chunk = Math.min(stackLimit, remaining);
        const slot = ++maxSlot;
        await db.insert(inventory).values({
          tavId,
          slot,
          itemId,
          qty: chunk,
        });
        stackList.push({ slot, qty: chunk });
        remaining -= chunk;
      }

      stacks.set(itemId, stackList);
      continue;
    }

    let remaining = Math.abs(change);

    for (let index = stackList.length - 1; index >= 0 && remaining > 0; index -= 1) {
      const stack = stackList[index]!;
      const remove = Math.min(stack.qty, remaining);
      const newQty = stack.qty - remove;

      if (newQty > 0) {
        await db
          .update(inventory)
          .set({ qty: newQty })
          .where(
            and(
              eq(inventory.tavId, tavId),
              eq(inventory.slot, stack.slot),
            ),
          );
        stack.qty = newQty;
      } else {
        await db
          .delete(inventory)
          .where(
            and(
              eq(inventory.tavId, tavId),
              eq(inventory.slot, stack.slot),
            ),
          );
        stackList.splice(index, 1);
      }

      remaining -= remove;
    }

    if (remaining > 0 && options.strict) {
      throw new Error(`Insufficient quantity for item ${itemId}`);
    }

    stacks.set(itemId, stackList);
  }

  existing = await listInventory(db, tavId);
  const sanitized = existing.filter((row) => Number(row.qty ?? 0) > 0);
  sanitized.sort((a, b) => Number(a.slot ?? 0) - Number(b.slot ?? 0));

  for (let index = 0; index < sanitized.length; index += 1) {
    const row = sanitized[index]!;
    if (row.slot !== index) {
      await db
        .update(inventory)
        .set({ slot: index })
        .where(
          and(
            eq(inventory.tavId, tavId),
            eq(inventory.slot, row.slot),
          ),
        );
    }
  }
}

function getTotalsFromStacks(
  stacks: Map<string, Array<{ slot: number; qty: number }>>,
): InventoryTotals {
  const totals: InventoryTotals = {};
  for (const [itemId, stackList] of stacks.entries()) {
    for (const stack of stackList) {
      totals[itemId] = (totals[itemId] ?? 0) + stack.qty;
    }
  }
  return totals;
}

export async function setInventoryItems(
  db: DatabaseClient,
  tavId: number,
  items: InventoryTotals,
): Promise<void> {
  await db.delete(inventory).where(eq(inventory.tavId, tavId));

  const entries = Object.entries(items)
    .filter(([, qty]) => Number.isFinite(qty) && Number(qty) > 0)
    .flatMap(([itemId, qty]) => {
      const definition = requireItemDefinition(itemId);
      const stackLimit = definition.stackLimit ?? Number.MAX_SAFE_INTEGER;
      const chunks: Array<{ itemId: string; qty: number }> = [];
      let remaining = Math.trunc(Number(qty));
      while (remaining > 0) {
        const chunk = Math.min(stackLimit, remaining);
        chunks.push({ itemId, qty: chunk });
        remaining -= chunk;
      }
      return chunks;
    });

  if (entries.length === 0) {
    return;
  }

  await db.insert(inventory).values(
    entries.map(({ itemId, qty }, index) => ({
      tavId,
      slot: index,
      itemId,
      qty,
    })),
  );
}

export async function getItemQuantity(
  db: DatabaseClient,
  tavId: number,
  itemId: string,
): Promise<number> {
  const totals = await getInventoryTotals(db, tavId);
  return totals[itemId] ?? 0;
}
