import { describe, expect, it } from "vitest";

import { mergeCompletionEffects } from "./task.js";

describe("mergeCompletionEffects", () => {
  it("sums xp and merges inventory, dropping zero totals", () => {
    const a = { tavXp: 10, skillXp: 5, inventory: { log: 2, torch: 0 } };
    const b = { tavXp: 0, skillXp: 5, inventory: { log: -2, plank: 1 } };
    const c = null;

    const result = mergeCompletionEffects(a, b, c);
    expect(result).toEqual({ tavXp: 10, skillXp: 10, inventory: { plank: 1 } });
  });

  it("returns null when all contributions cancel to zero", () => {
    const out = mergeCompletionEffects(
      { tavXp: 0, skillXp: 0, inventory: { x: 1 } },
      { inventory: { x: -1 } },
    );
    expect(out).toBeNull();
  });
});

