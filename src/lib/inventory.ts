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
  /** Strict mode prevents underflow and throws when removing more than available. Default: true. */
  strict?: boolean;
};

/* ────────────────────────────────────────────────────────────────────────── *
 * Public API
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Move/merge/swap an item stack between two slots. Preserves slot indices (no compaction).
 * - Empty destination → move stack.
 * - Same item → merge up to stack limit; keep leftover at fromSlot.
 * - Different items → swap.
 */
export async function moveInventoryItem(
  db: DatabaseClient,
  tavId: number,
  fromSlot: number,
  toSlot: number,
): Promise<void> {
  assertSlot(fromSlot, "fromSlot");
  assertSlot(toSlot, "toSlot");

  await db.transaction(async (tx) => {
    const rows = await listInventory(tx, tavId);

    // Current state keyed by slot (number → { itemId, qty })
    const bySlot = mapBySlot(rows);

    const from = bySlot.get(fromSlot);
    if (!from) {
      throw new Error(`No inventory item found in slot ${fromSlot}`);
    }

    const to = bySlot.get(toSlot);
    const stackLimit = getStackLimitSafe(from.itemId);

    if (!to) {
      // Empty destination: move entire stack
      bySlot.delete(fromSlot);
      bySlot.set(toSlot, { ...from });
    } else if (to.itemId === from.itemId) {
      // Same item: merge up to limit; remainder stays at fromSlot
      const total = to.qty + from.qty;
      const merged = Math.min(stackLimit, total);
      const leftover = total - merged;

      bySlot.set(toSlot, { itemId: to.itemId, qty: merged });
      if (leftover > 0) {
        bySlot.set(fromSlot, { itemId: from.itemId, qty: leftover });
      } else {
        bySlot.delete(fromSlot);
      }
    } else {
      // Different item: swap
      bySlot.set(fromSlot, { ...to });
      bySlot.set(toSlot, { ...from });
    }

    await persistExactSnapshot(tx, tavId, bySlot);
  });
}

/** Ordered list of inventory records for a tav. */
export async function listInventory(
  db: DatabaseClient,
  tavId: number,
): Promise<InventoryRow[]> {
  return db.query.inventory.findMany({
    where: (rows, { eq: eqOp }) => eqOp(rows.tavId, tavId),
    orderBy: (rows, { asc }) => [asc(rows.slot)],
  });
}

/** Totals per itemId (sums all stacks). */
export async function getInventoryTotals(
  db: DatabaseClient,
  tavId: number,
): Promise<InventoryTotals> {
  const rows = await listInventory(db, tavId);
  const totals: InventoryTotals = {};
  for (const row of rows) {
    const qty = toInt(row.qty);
    totals[row.itemId] = (totals[row.itemId] ?? 0) + qty;
  }
  return totals;
}

/**
 * Apply item deltas atomically.
 * - Positive values add items (top up existing stacks, then open new slots).
 * - Negative values remove items (LIFO across that item’s stacks).
 * - In strict mode, throws on underflow.
 * - Preserves existing slot numbers; newly created stacks use the smallest free slot index.
 */
export async function applyInventoryDelta(
  db: DatabaseClient,
  tavId: number,
  deltas: InventoryDelta,
  options: ApplyDeltaOptions = { strict: true },
): Promise<void> {
  const entries = Object.entries(deltas).filter(([, v]) => toInt(v) !== 0);
  if (entries.length === 0) return;

  await db.transaction(async (tx) => {
    // Load existing stacks and occupancy
    const existing = await listInventory(tx, tavId);
    const stacks = buildStacks(existing); // Map<itemId, Array<{slot, qty}>>
    const occupied = new Set<number>(existing.map((r) => toInt(r.slot)));

    // Strict underflow check on totals
    if (options.strict) {
      const totals = totalsFromStacks(stacks);
      for (const [itemId, change] of entries) {
        const c = toInt(change);
        if (c < 0 && (totals[itemId] ?? 0) + c < 0) {
          throw new Error(`Insufficient quantity for item ${itemId}`);
        }
        totals[itemId] = (totals[itemId] ?? 0) + c;
      }
    }

    const smallestEmptySlot = () => nextFreeSlot(occupied);

    for (const [itemId, rawChange] of entries) {
      const change = toInt(rawChange);
      if (change === 0) continue;

      const stackLimit = getStackLimitSafe(itemId);
      const stackList = stacks.get(itemId) ?? [];

      if (change > 0) {
        let remaining = change;

        // 1) Top up existing stacks
        for (const s of stackList) {
          if (remaining <= 0) break;
          const capacity = stackLimit - s.qty;
          if (capacity <= 0) continue;

          const add = Math.min(capacity, remaining);
          if (add > 0) {
            await tx
              .update(inventory)
              .set({ qty: s.qty + add })
              .where(
                and(eq(inventory.tavId, tavId), eq(inventory.slot, s.slot)),
              );
            s.qty += add;
            remaining -= add;
          }
        }

        // 2) Open new stacks in the smallest free slots
        while (remaining > 0) {
          const chunk = Math.min(stackLimit, remaining);
          const slot = smallestEmptySlot();
          await tx
            .insert(inventory)
            .values({ tavId, slot, itemId, qty: chunk });

          stackList.push({ slot, qty: chunk });
          occupied.add(slot);
          remaining -= chunk;
        }

        stacks.set(itemId, stackList);
        continue;
      }

      // change < 0: remove from the most recently created stacks first (LIFO)
      let remaining = Math.abs(change);
      for (let i = stackList.length - 1; i >= 0 && remaining > 0; i -= 1) {
        const s = stackList[i]!;
        const remove = Math.min(s.qty, remaining);
        const newQty = s.qty - remove;

        if (newQty > 0) {
          await tx
            .update(inventory)
            .set({ qty: newQty })
            .where(and(eq(inventory.tavId, tavId), eq(inventory.slot, s.slot)));
          s.qty = newQty;
        } else {
          await tx
            .delete(inventory)
            .where(and(eq(inventory.tavId, tavId), eq(inventory.slot, s.slot)));
          stackList.splice(i, 1);
          occupied.delete(s.slot);
        }

        remaining -= remove;
      }

      if (remaining > 0 && options.strict) {
        throw new Error(`Insufficient quantity for item ${itemId}`);
      }

      stacks.set(itemId, stackList);
    }
  });
}

/**
 * Replace the tav’s inventory with the exact item totals (split across stacks by stack limit).
 * Slot indices are assigned from 0..N-1 in insertion order.
 */
export async function setInventoryItems(
  db: DatabaseClient,
  tavId: number,
  items: InventoryTotals,
): Promise<void> {
  const chunks = chunkifyTotals(items);
  await db.transaction(async (tx) => {
    await tx.delete(inventory).where(eq(inventory.tavId, tavId));
    if (chunks.length === 0) return;

    const values = chunks.map(({ itemId, qty }, idx) => ({
      tavId,
      slot: idx,
      itemId,
      qty,
    }));
    await tx.insert(inventory).values(values);
  });
}

/** Convenience: read the current total quantity for an item. */
export async function getItemQuantity(
  db: DatabaseClient,
  tavId: number,
  itemId: string,
): Promise<number> {
  const totals = await getInventoryTotals(db, tavId);
  return totals[itemId] ?? 0;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Internals / Helpers
 * ────────────────────────────────────────────────────────────────────────── */

function assertSlot(value: number, label: string): void {
  if (!(Number.isInteger(value) && value >= 0)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function toInt(n: unknown): number {
  // We only store small ints; coerce and floor to be safe.
  const v = Math.trunc(Number(n));
  return Number.isFinite(v) ? v : 0;
}

function getStackLimitSafe(itemId: string): number {
  // Prefer per-item limit; fall back to global default if absent.
  const def = requireItemDefinition(itemId);
  return def.stackLimit ?? DEfAULT_STACK_LIMIT;
}

type SlotRec = { itemId: string; qty: number };

function mapBySlot(rows: InventoryRow[]): Map<number, SlotRec> {
  const m = new Map<number, SlotRec>();
  for (const r of rows) {
    m.set(toInt(r.slot), { itemId: r.itemId, qty: toInt(r.qty) });
  }
  return m;
}

/** Persist an in-memory snapshot (slot→{itemId,qty}) exactly as given. */
async function persistExactSnapshot(
  db: DatabaseClient,
  tavId: number,
  bySlot: Map<number, SlotRec>,
): Promise<void> {
  // Sort by slot to have a deterministic write order.
  const values = Array.from(bySlot.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([slot, rec]) => ({ tavId, slot, itemId: rec.itemId, qty: rec.qty }));

  await db.delete(inventory).where(eq(inventory.tavId, tavId));
  if (values.length > 0) {
    await db.insert(inventory).values(values);
  }
}

function buildStacks(
  rows: InventoryRow[],
): Map<string, Array<{ slot: number; qty: number }>> {
  const stacks = new Map<string, Array<{ slot: number; qty: number }>>();
  for (const r of rows) {
    const slot = toInt(r.slot);
    const qty = toInt(r.qty);
    const list = stacks.get(r.itemId) ?? [];
    list.push({ slot, qty });
    stacks.set(r.itemId, list);
  }
  // Maintain deterministic LIFO by slot (older first, newer last)
  for (const [, list] of stacks) {
    list.sort((a, b) => a.slot - b.slot);
  }
  return stacks;
}

function totalsFromStacks(
  stacks: Map<string, Array<{ slot: number; qty: number }>>,
): InventoryTotals {
  const totals: InventoryTotals = {};
  for (const [itemId, list] of stacks) {
    let sum = 0;
    for (const s of list) sum += s.qty;
    totals[itemId] = sum;
  }
  return totals;
}

function nextFreeSlot(occupied: Set<number>): number {
  let s = 0;
  while (occupied.has(s)) s += 1;
  return s;
}

function chunkifyTotals(
  items: InventoryTotals,
): Array<{ itemId: string; qty: number }> {
  const out: Array<{ itemId: string; qty: number }> = [];
  for (const [itemId, raw] of Object.entries(items)) {
    let remaining = Math.max(0, toInt(raw));
    if (remaining === 0) continue;

    const limit = getStackLimitSafe(itemId);
    while (remaining > 0) {
      const chunk = Math.min(limit, remaining);
      out.push({ itemId, qty: chunk });
      remaining -= chunk;
    }
  }
  return out;
}
