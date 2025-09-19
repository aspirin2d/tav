import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyInventoryDelta,
  getItemQuantity,
  getInventoryTotals,
  listInventory,
  moveInventoryItem,
  setInventoryItems,
  type DatabaseClient,
} from "./inventory.js";
import { ITEM_DEFINITIONS } from "../config.js";
import { createTav } from "./tav.js";
import * as schema from "../db/schema.js";

function migrationsPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return join(currentDir, "../../drizzle");
}

describe("inventory helpers", () => {
  let client: PGlite;
  let db: DatabaseClient;
  let tavId: number;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle({ client, schema }) as DatabaseClient;
    await migrate(db, { migrationsFolder: migrationsPath() });
    const tav = await createTav(db, { name: "Storage" });
    tavId = tav.id;
  });

  afterEach(async () => {
    await client.close();
  });

  it("has definitions for items referenced in tests", () => {
    const ids = ITEM_DEFINITIONS.map((definition) => definition.id);
    expect(ids).toEqual(expect.arrayContaining(["log", "torch", "plank"]));
  });

  it("adds items and reuses slots for existing stacks", async () => {
    await applyInventoryDelta(db, tavId, { log: 2 });
    await applyInventoryDelta(db, tavId, { log: 1 });
    await applyInventoryDelta(db, tavId, { torch: 1 });

    const totals = await getInventoryTotals(db, tavId);
    expect(totals).toEqual({ log: 3, torch: 1 });

    const rows = await listInventory(db, tavId);
    expect(rows.map(({ slot, itemId, qty }) => ({ slot, itemId, qty }))).toEqual([
      { slot: 0, itemId: "log", qty: 3 },
      { slot: 1, itemId: "torch", qty: 1 },
    ]);
  });

  it("removes items and drops empty slots", async () => {
    await setInventoryItems(db, tavId, { log: 3, torch: 1 });

    await applyInventoryDelta(db, tavId, { log: -2, torch: -1 });

    const totals = await getInventoryTotals(db, tavId);
    expect(totals).toEqual({ log: 1 });

    const rows = await listInventory(db, tavId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ slot: 0, itemId: "log", qty: 1 });
  });

  it("splits stacks according to the configured stack limit", async () => {
    await applyInventoryDelta(db, tavId, { torch: 12 });

    const rows = await listInventory(db, tavId);
    expect(rows.map((row) => row.qty)).toEqual([5, 5, 2]);
  });

  it("handles removal of non-existent stacks in non-strict mode", async () => {
    await setInventoryItems(db, tavId, { log: 2 });

    await applyInventoryDelta(db, tavId, { plank: -1 });

    const totals = await getInventoryTotals(db, tavId);
    expect(totals).toEqual({ log: 2 });
  });

  it("ignores no-op deltas", async () => {
    await setInventoryItems(db, tavId, { log: 2 });

    await applyInventoryDelta(db, tavId, { log: 0 });

    const totals = await getInventoryTotals(db, tavId);
    expect(totals).toEqual({ log: 2 });
  });

  it("moves a stack to an empty slot at the end", async () => {
    await setInventoryItems(db, tavId, { log: 3, torch: 1, plank: 2 });

    await moveInventoryItem(db, tavId, 0, 5);

    const rows = await listInventory(db, tavId);
    expect(rows.map((row) => row.itemId)).toEqual(["torch", "plank", "log"]);
  });

  it("swaps stacks when moving into an occupied slot", async () => {
    await setInventoryItems(db, tavId, { log: 3, torch: 1 });

    await moveInventoryItem(db, tavId, 0, 1);

    const rows = await listInventory(db, tavId);
    expect(rows.map((row) => row.itemId)).toEqual(["torch", "log"]);
  });

  it("merges stacks when the target has room", async () => {
    await setInventoryItems(db, tavId, { torch: 7 });

    await applyInventoryDelta(db, tavId, { torch: 3 });
    await moveInventoryItem(db, tavId, 1, 0);

    const rows = await listInventory(db, tavId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ itemId: "torch", qty: 5 });
    expect(rows[1]).toMatchObject({ itemId: "torch", qty: 5 });
  });

  it("creates a new stack when merging overflows the limit", async () => {
    await setInventoryItems(db, tavId, { torch: 5, log: 2 });

    await applyInventoryDelta(db, tavId, { torch: 6 });
    await moveInventoryItem(db, tavId, 2, 0);

    const rows = await listInventory(db, tavId);
    const torchStacks = rows
      .filter((row) => row.itemId === "torch")
      .map((row) => row.qty)
      .sort((a, b) => a - b);
    expect(torchStacks).toEqual([1, 5, 5]);

    const logStack = rows.find((row) => row.itemId === "log");
    expect(logStack?.qty).toBe(2);
  });

  it("throws when moving from an empty slot", async () => {
    await setInventoryItems(db, tavId, { log: 2 });

    await expect(moveInventoryItem(db, tavId, 5, 0)).rejects.toThrow(
      /No inventory item found in slot/,
    );
  });

  it("validates slot inputs", async () => {
    await setInventoryItems(db, tavId, { log: 2 });

    await expect(moveInventoryItem(db, tavId, -1, 0)).rejects.toThrow(
      /Invalid fromSlot/,
    );

    await expect(moveInventoryItem(db, tavId, 0, 1.5)).rejects.toThrow(
      /Invalid toSlot/,
    );
  });

  it("stops filling once stacks reach capacity", async () => {
    await setInventoryItems(db, tavId, { torch: 4 });

    await applyInventoryDelta(db, tavId, { torch: 1 });

    const rows = await listInventory(db, tavId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ itemId: "torch", qty: 5 });
  });

  it("skips full stacks when adding new quantities", async () => {
    await setInventoryItems(db, tavId, { torch: 5, plank: 3 });
    await applyInventoryDelta(db, tavId, { torch: 3 });

    const rows = await listInventory(db, tavId);
    expect(rows.map((row) => ({ itemId: row.itemId, qty: row.qty }))).toEqual([
      { itemId: "torch", qty: 5 },
      { itemId: "plank", qty: 3 },
      { itemId: "torch", qty: 3 },
    ]);
  });

  it("breaks early once additions are satisfied", async () => {
    await setInventoryItems(db, tavId, { torch: 12 });
    await moveInventoryItem(db, tavId, 2, 0);

    await applyInventoryDelta(db, tavId, { torch: 3 });

    const rows = await listInventory(db, tavId);
    const torchStacks = rows
      .filter((row) => row.itemId === "torch")
      .map((row) => row.qty)
      .sort((a, b) => a - b);
    expect(torchStacks).toEqual([5, 5, 5]);
  });

  it("throws when strict mode would drive counts negative", async () => {
    await setInventoryItems(db, tavId, { log: 1 });

    await expect(
      applyInventoryDelta(db, tavId, { log: -2 }, { strict: true }),
    ).rejects.toThrow(/Insufficient quantity/);

    const totals = await getInventoryTotals(db, tavId);
    expect(totals).toEqual({ log: 1 });
  });

  it("replaces the entire inventory set", async () => {
    await setInventoryItems(db, tavId, { log: 2, torch: 1 });
    await setInventoryItems(db, tavId, { plank: 3 });

    const totals = await getInventoryTotals(db, tavId);
    expect(totals).toEqual({ plank: 3 });

    const qty = await getItemQuantity(db, tavId, "plank");
    expect(qty).toBe(3);
  });

  it("skips inserts when replacements contain no positive quantities", async () => {
    await setInventoryItems(db, tavId, { log: 2 });
    await setInventoryItems(db, tavId, { log: 0, torch: -1 });

    const totals = await getInventoryTotals(db, tavId);
    expect(totals).toEqual({});
  });
});
