import { and, eq } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";

import { inventory } from "../db/schema.js";
import * as schema from "../db/schema.js";
import { requireItemDefinition } from "./items.js";
import { DEfAULT_STACK_LIMIT } from "../config.js";

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
  if (toSlot < 0 || !Number.isInteger(toSlot)) {
    throw new Error(`Invalid toSlot: ${toSlot}`);
  }

  // Load current inventory keyed by slot (no ordering assumptions)
  const rows = await listInventory(db, tavId);
  const bySlot = new Map<number, { itemId: string; qty: number }>();
  for (const r of rows) {
    bySlot.set(Number(r.slot), { itemId: r.itemId, qty: Number(r.qty) });
  }

  const from = bySlot.get(fromSlot);
  if (!from) {
    throw new Error(`No inventory item found in slot ${fromSlot}`);
  }

  const to = bySlot.get(toSlot);
  const def = requireItemDefinition(from.itemId);
  const stackLimit = def.stackLimit ?? DEfAULT_STACK_LIMIT;

  if (!to) {
    // Empty destination: move the whole stack to toSlot
    bySlot.delete(fromSlot);
    bySlot.set(toSlot, { ...from });
  } else if (to.itemId === from.itemId) {
    // Same item: merge up to stack limit; keep leftover at original fromSlot
    const total = to.qty + from.qty;
    const merged = Math.min(stackLimit, total);
    const leftover = total - merged;

    // Write merged stack at toSlot
    bySlot.set(toSlot, { itemId: to.itemId, qty: merged });

    if (leftover > 0) {
      // Keep leftover at original slot (unchanged slot index)
      bySlot.set(fromSlot, { itemId: from.itemId, qty: leftover });
    } else {
      // Fully merged; clear original slot
      bySlot.delete(fromSlot);
    }
  } else {
    // Different item at destination: swap slots
    bySlot.set(fromSlot, { ...to });
    bySlot.set(toSlot, { ...from });
  }

  // Persist exactly the slot keys as-is (no compaction/reindexing)
  await db.delete(inventory).where(eq(inventory.tavId, tavId));
  if (bySlot.size === 0) return;

  const values = Array.from(bySlot.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([slot, rec]) => ({
      tavId,
      slot,
      itemId: rec.itemId,
      qty: rec.qty,
    }));

  await db.insert(inventory).values(values);
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
  options: ApplyDeltaOptions = { strict: true },
): Promise<void> {
  const entries = Object.entries(deltas).filter(([, value]) => value !== 0);
  if (entries.length === 0) return;

  // Load existing stacks; also track occupied slots
  let existing = await listInventory(db, tavId);
  const stacks = new Map<string, Array<{ slot: number; qty: number }>>();
  const occupied = new Set<number>();

  for (const row of existing) {
    const slot = Number(row.slot ?? 0);
    const qty = Number(row.qty ?? 0);
    const list = stacks.get(row.itemId) ?? [];
    list.push({ slot, qty });
    stacks.set(row.itemId, list);
    occupied.add(slot);
  }

  // Strict underflow check (item totals)
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

  // Helper: find the smallest non-negative empty slot
  const smallestEmptySlot = () => {
    let s = 0;
    while (occupied.has(s)) s += 1;
    return s;
  };

  for (const [itemId, rawChange] of entries) {
    const def = requireItemDefinition(itemId);
    const stackLimit = def.stackLimit ?? DEfAULT_STACK_LIMIT;
    const change = Math.trunc(Number(rawChange));
    /* c8 ignore next */
    if (!Number.isFinite(change) || change === 0) continue;

    const stackList = stacks.get(itemId) ?? [];

    if (change > 0) {
      // 1) Top off existing stacks
      let remaining = change;

      for (const stack of stackList) {
        if (remaining <= 0) break;
        const capacity = stackLimit - stack.qty;
        if (capacity <= 0) continue;

        const add = Math.min(capacity, remaining);
        await db
          .update(inventory)
          .set({ qty: stack.qty + add })
          .where(
            and(eq(inventory.tavId, tavId), eq(inventory.slot, stack.slot)),
          );

        stack.qty += add;
        remaining -= add;
      }

      // 2) Create new stacks at the smallest empty slots
      while (remaining > 0) {
        const chunk = Math.min(stackLimit, remaining);
        const slot = smallestEmptySlot();

        await db.insert(inventory).values({
          tavId,
          slot,
          itemId,
          qty: chunk,
        });

        stackList.push({ slot, qty: chunk });
        occupied.add(slot);
        remaining -= chunk;
      }

      stacks.set(itemId, stackList);
      continue;
    }

    // change < 0: remove from the last stacks first (LIFO)
    let remaining = Math.abs(change);

    for (let i = stackList.length - 1; i >= 0 && remaining > 0; i -= 1) {
      const stack = stackList[i]!;
      const remove = Math.min(stack.qty, remaining);
      const newQty = stack.qty - remove;

      if (newQty > 0) {
        await db
          .update(inventory)
          .set({ qty: newQty })
          .where(
            and(eq(inventory.tavId, tavId), eq(inventory.slot, stack.slot)),
          );
        stack.qty = newQty;
      } else {
        await db
          .delete(inventory)
          .where(
            and(eq(inventory.tavId, tavId), eq(inventory.slot, stack.slot)),
          );
        stackList.splice(i, 1);
        occupied.delete(stack.slot); // free this slot
      }

      remaining -= remove;
    }

    if (remaining > 0 && options.strict) {
      throw new Error(`Insufficient quantity for item ${itemId}`);
    }

    stacks.set(itemId, stackList);
  }

  // NOTE: No reindexing/compaction here — slots are preserved.
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
      const stackLimit = definition.stackLimit ?? DEfAULT_STACK_LIMIT;
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
