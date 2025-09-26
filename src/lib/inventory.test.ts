import {
  describe,
  it,
  beforeAll,
  afterAll,
  beforeEach,
  expect,
  vi,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";

import * as schema from "../db/schema.js";
import {
  listInventory,
  getInventoryTotals,
  applyInventoryDelta,
  setInventoryItems,
  moveInventoryItem,
  getItemQuantity,
  type InventoryTotals,
  compactInventory,
} from "./inventory.js";

// --- Mock item defs: define stack limits per item id ---
vi.mock("./items.js", () => {
  return {
    requireItemDefinition: (itemId: string) => {
      // default big stacks unless overridden:
      const stackMap: Record<string, number> = {
        copper: 20,
        iron: 10,
        gold: 5,
        apple: 99,
      };
      return {
        id: itemId,
        name: itemId,
        description: "",
        stackLimit: stackMap[itemId] ?? 9999,
      };
    },
  };
});

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
const TAV_ID = 1;

async function createInventoryTable() {
  // minimal DDL to satisfy queries used by the module
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS inventory (
      tav_id     INTEGER NOT NULL,
      slot       SMALLINT NOT NULL,
      item_id    TEXT NOT NULL,
      qty        SMALLINT NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (slot, tav_id)
    );
  `);
}

async function truncateInventory() {
  await db.execute(sql`DELETE FROM inventory;`);
}

describe("inventory", () => {
  beforeAll(async () => {
    client = new PGlite(); // in-memory
    db = drizzle({ client, schema });
    await createInventoryTable();
  });

  afterAll(async () => {
    await client.close();
  });

  beforeEach(async () => {
    await truncateInventory();
  });

  it("listInventory returns empty initially", async () => {
    const rows = await listInventory(db, TAV_ID);
    expect(rows).toEqual([]);
  });

  it("setInventoryItems splits into stacks by stackLimit and assigns compact slots", async () => {
    const items: InventoryTotals = { copper: 42, gold: 7, apple: 1 };
    await setInventoryItems(db, TAV_ID, items);

    const rows = await listInventory(db, TAV_ID);
    // copper stackLimit=20 => 20,20,2
    // gold stackLimit=5 => 5,2
    // apple stackLimit=99 => 1
    expect(
      rows.map((r) => ({
        slot: Number(r.slot),
        itemId: r.itemId,
        qty: Number(r.qty),
      })),
    ).toEqual([
      { slot: 0, itemId: "copper", qty: 20 },
      { slot: 1, itemId: "copper", qty: 20 },
      { slot: 2, itemId: "copper", qty: 2 },
      { slot: 3, itemId: "gold", qty: 5 },
      { slot: 4, itemId: "gold", qty: 2 },
      { slot: 5, itemId: "apple", qty: 1 },
    ]);
  });

  it("set inventory with empty list, will remove all inventories", async () => {
    const items: InventoryTotals = {};
    await setInventoryItems(db, TAV_ID, items);
    const rows = await listInventory(db, TAV_ID);
    expect(rows.length).toBe(0);
  });

  it("getInventoryTotals aggregates quantities across stacks", async () => {
    await db.insert(schema.inventory).values([
      { tavId: TAV_ID, slot: 0, itemId: "iron", qty: 7 },
      { tavId: TAV_ID, slot: 1, itemId: "iron", qty: 3 },
      { tavId: TAV_ID, slot: 2, itemId: "copper", qty: 5 },
    ]);
    const totals = await getInventoryTotals(db, TAV_ID);
    expect(totals).toEqual({ iron: 10, copper: 5 });
  });

  it("applyInventoryDelta adds with stacking then creates new stacks", async () => {
    // start with copper: [18] (cap 20)
    await db
      .insert(schema.inventory)
      .values([{ tavId: TAV_ID, slot: 0, itemId: "copper", qty: 18 }]);
    await applyInventoryDelta(db, TAV_ID, { copper: 7 }); // +7 => [20],[5]
    const rows = await listInventory(db, TAV_ID);
    expect(rows.map((r) => ({ itemId: r.itemId, qty: Number(r.qty) }))).toEqual(
      [
        { itemId: "copper", qty: 20 },
        { itemId: "copper", qty: 5 },
      ],
    );
  });

  it("applyInventoryDelta removes from the end stacks first; compacts slots", async () => {
    // copper: [20, 20, 2]
    await db.insert(schema.inventory).values([
      { tavId: TAV_ID, slot: 0, itemId: "copper", qty: 20 },
      { tavId: TAV_ID, slot: 1, itemId: "copper", qty: 20 },
      { tavId: TAV_ID, slot: 2, itemId: "copper", qty: 2 },
      { tavId: TAV_ID, slot: 3, itemId: "iron", qty: 5 },
    ]);
    await applyInventoryDelta(db, TAV_ID, { copper: -21 }); // remove 21 -> [20,1]
    const rows = await listInventory(db, TAV_ID);
    expect(
      rows.map((r) => ({
        slot: Number(r.slot),
        itemId: r.itemId,
        qty: Number(r.qty),
      })),
    ).toEqual([
      { slot: 0, itemId: "copper", qty: 20 },
      { slot: 1, itemId: "copper", qty: 1 },
      { slot: 3, itemId: "iron", qty: 5 },
    ]);
  });

  it("applyInventoryDelta throws on insufficient quantity when strict=true", async () => {
    await db
      .insert(schema.inventory)
      .values([{ tavId: TAV_ID, slot: 0, itemId: "iron", qty: 3 }]);
    await expect(
      applyInventoryDelta(db, TAV_ID, { iron: -5 }, { strict: true }),
    ).rejects.toThrow(/Insufficient quantity for item iron/);
  });

  it("applyInventoryDelta creates new stack if no same items found", async () => {
    await db.insert(schema.inventory).values([
      { tavId: TAV_ID, slot: 0, itemId: "iron", qty: 20 },
      { tavId: TAV_ID, slot: 2, itemId: "gold", qty: 3 },
    ]);

    await applyInventoryDelta(db, TAV_ID, { copper: 20 }); // remove 21 -> [20,1]
    let rows = await listInventory(db, TAV_ID);
    expect(
      rows.map((r) => ({
        slot: Number(r.slot),
        itemId: r.itemId,
        qty: Number(r.qty),
      })),
    ).toEqual([
      { slot: 0, itemId: "iron", qty: 20 },
      { slot: 1, itemId: "copper", qty: 20 },
      { slot: 2, itemId: "gold", qty: 3 },
    ]);

    await applyInventoryDelta(db, TAV_ID, { apple: 120 }); // remove 21 -> [20,1]

    rows = await listInventory(db, TAV_ID);
    expect(
      rows.map((r) => ({
        slot: Number(r.slot),
        itemId: r.itemId,
        qty: Number(r.qty),
      })),
    ).toEqual([
      { slot: 0, itemId: "iron", qty: 20 },
      { slot: 1, itemId: "copper", qty: 20 },
      { slot: 2, itemId: "gold", qty: 3 },
      { slot: 3, itemId: "apple", qty: 99 },
      { slot: 4, itemId: "apple", qty: 21 },
    ]);
  });

  it("applyInventoryDelta ignores no-op deltas and compacts nothing", async () => {
    await applyInventoryDelta(db, TAV_ID, { iron: 0, foo: 0 });
    const rows = await listInventory(db, TAV_ID);
    expect(rows).toEqual([]);
  });

  it("moveInventoryItem reorders within bounds and merges with same item respecting stackLimit", async () => {
    // slots: 0:copper(15), 1:gold(4), 2:copper(10)  [copper cap 20, gold cap 5]
    await db.insert(schema.inventory).values([
      { tavId: TAV_ID, slot: 0, itemId: "copper", qty: 15 },
      { tavId: TAV_ID, slot: 1, itemId: "gold", qty: 4 },
      { tavId: TAV_ID, slot: 2, itemId: "copper", qty: 10 },
    ]);

    // move slot 2 (copper 10) to index 1 (before gold), merges with copper at new position (slot 0 after compaction)
    await moveInventoryItem(db, TAV_ID, 2, 0);
    let rows = await listInventory(db, TAV_ID);
    // resulting: copper 20 (15+5), copper 5 (leftover), gold 4
    expect(rows.map((r) => ({ itemId: r.itemId, qty: Number(r.qty) }))).toEqual(
      [
        { itemId: "copper", qty: 20 },
        { itemId: "gold", qty: 4 },
        { itemId: "copper", qty: 5 },
      ],
    );

    // move gold(4) to end (past length) -> should append
    await moveInventoryItem(db, TAV_ID, 1, 99);
    rows = await listInventory(db, TAV_ID);
    expect(
      rows.map((r) => ({ itemId: r.itemId, qty: Number(r.qty), slot: r.slot })),
    ).toEqual([
      { itemId: "copper", qty: 20, slot: 0 },
      { itemId: "copper", qty: 5, slot: 2 },
      { itemId: "gold", qty: 4, slot: 99 },
    ]);
  });

  it("moveInventoryItem reinserts sole item when destination list is empty", async () => {
    await db
      .insert(schema.inventory)
      .values([{ tavId: TAV_ID, slot: 5, itemId: "apple", qty: 3 }]);

    await moveInventoryItem(db, TAV_ID, 5, 2);

    const rows = await listInventory(db, TAV_ID);
    expect(
      rows.map((r) => ({
        slot: Number(r.slot),
        itemId: r.itemId,
        qty: Number(r.qty),
      })),
    ).toEqual([{ slot: 2, itemId: "apple", qty: 3 }]);
  });

  it("moveInventoryItem drops zero-quantity rows during rewrite", async () => {
    await db
      .insert(schema.inventory)
      .values([{ tavId: TAV_ID, slot: 0, itemId: "apple", qty: 0 }]);

    await moveInventoryItem(db, TAV_ID, 0, 0);

    const rows = await listInventory(db, TAV_ID);
    expect(rows).toEqual([]);
  });

  it("moveInventoryItem swap items if id is not the same", async () => {
    await db.insert(schema.inventory).values([
      { tavId: TAV_ID, slot: 0, itemId: "apple", qty: 1 },
      { tavId: TAV_ID, slot: 1, itemId: "iron", qty: 1 },
    ]);

    await moveInventoryItem(db, TAV_ID, 0, 1);

    const rows = await listInventory(db, TAV_ID);
    expect(
      rows.map((r) => ({ itemId: r.itemId, qty: Number(r.qty), slot: r.slot })),
    ).toEqual([
      { itemId: "iron", qty: 1, slot: 0 },
      { itemId: "apple", qty: 1, slot: 1 },
    ]);
  });

  it("getItemQuantity returns 0 when absent and exact count when present", async () => {
    await db.insert(schema.inventory).values([
      { tavId: TAV_ID, slot: 0, itemId: "gold", qty: 3 },
      { tavId: TAV_ID, slot: 1, itemId: "gold", qty: 2 },
    ]);
    expect(await getItemQuantity(db, TAV_ID, "gold")).toBe(5);
    expect(await getItemQuantity(db, TAV_ID, "copper")).toBe(0);
  });

  it("applyInventoryDelta with mixed positive/negative nets zero removes stacks entirely", async () => {
    await db
      .insert(schema.inventory)
      .values([{ tavId: TAV_ID, slot: 0, itemId: "iron", qty: 6 }]);
    await applyInventoryDelta(db, TAV_ID, { iron: -6, copper: 0 });
    const rows = await listInventory(db, TAV_ID);
    expect(rows).toEqual([]);
  });

  it("setInventoryItems with non-positive values ignores them", async () => {
    const items = {
      copper: 10,
      trash: 0,
      debt: -5,
    } as unknown as InventoryTotals;
    await setInventoryItems(db, TAV_ID, items);
    const rows = await listInventory(db, TAV_ID);
    expect(rows.map((r) => ({ itemId: r.itemId, qty: Number(r.qty) }))).toEqual(
      [{ itemId: "copper", qty: 10 }],
    );
  });

  it("compactInventory merges stacks and reassigns contiguous slots", async () => {
    // Create sparse, partially filled stacks
    await db.insert(schema.inventory).values([
      { tavId: TAV_ID, slot: 0, itemId: "copper", qty: 18 }, // cap 20
      { tavId: TAV_ID, slot: 5, itemId: "copper", qty: 7 },
      { tavId: TAV_ID, slot: 9, itemId: "gold", qty: 2 }, // cap 5
      { tavId: TAV_ID, slot: 12, itemId: "gold", qty: 4 },
    ]);

    await compactInventory(db, TAV_ID);

    const rows = await listInventory(db, TAV_ID);
    // copper total 25 => [20,5]; gold total 6 => [5,1]; slots 0..3
    expect(
      rows.map((r) => ({ slot: Number(r.slot), itemId: r.itemId, qty: Number(r.qty) })),
    ).toEqual([
      { slot: 0, itemId: "copper", qty: 20 },
      { slot: 1, itemId: "copper", qty: 5 },
      { slot: 2, itemId: "gold", qty: 5 },
      { slot: 3, itemId: "gold", qty: 1 },
    ]);
  });

  it("moveInventoryItem throws for invalid fromSlot (<0)", async () => {
    await expect(moveInventoryItem(db, TAV_ID, -1, 0)).rejects.toThrow(
      "Invalid fromSlot: -1",
    );
  });

  it("moveInventoryItem throws for invalid toSlot (<0)", async () => {
    await db
      .insert(schema.inventory)
      .values([{ tavId: TAV_ID, slot: 0, itemId: "copper", qty: 1 }]);
    await expect(moveInventoryItem(db, TAV_ID, 0, -5)).rejects.toThrow(
      "Invalid toSlot: -5",
    );
  });

  it("moveInventoryItem throws for invalid fromSlot (non-integer)", async () => {
    // passing non-integer to hit runtime guard
    await expect(moveInventoryItem(db, TAV_ID, 1.5, 0)).rejects.toThrow(
      "Invalid fromSlot: 1.5",
    );
  });

  it("moveInventoryItem throws for invalid toSlot (non-integer)", async () => {
    // seed a row so fromSlot exists
    await db
      .insert(schema.inventory)
      .values([{ tavId: TAV_ID, slot: 0, itemId: "copper", qty: 1 }]);
    // passing non-integer to hit runtime guard
    await expect(moveInventoryItem(db, TAV_ID, 0, 2.25)).rejects.toThrow(
      "Invalid toSlot: 2.25",
    );
  });

  it("moveInventoryItem throws when no item exists at fromSlot", async () => {
    // seed slots 0 and 2, but leave slot 1 empty
    await db.insert(schema.inventory).values([
      { tavId: TAV_ID, slot: 0, itemId: "copper", qty: 3 },
      { tavId: TAV_ID, slot: 2, itemId: "gold", qty: 1 },
    ]);

    await expect(moveInventoryItem(db, TAV_ID, 1, 0)).rejects.toThrow(
      "No inventory item found in slot 1",
    );
  });
});
