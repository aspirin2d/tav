import { describe, expect, it } from "vitest";

import { mergeRequirementContexts, type MergeRequirementContextOptions } from "./tav.js";

describe("mergeRequirementContexts", () => {
  it("adds inventory quantities by default and unions flags", () => {
    const base = {
      abilities: { str: 8, dex: 10 as number },
      skillLevels: { logging: 2 },
      inventory: { log: 1 },
      flags: new Set(["forest_access"]),
      customChecks: { a: true },
      resolveCustom: (name: string) => name === "always_true",
    };

    const override = {
      abilities: { str: 10 },
      skillLevels: { wood_craft: 1 },
      inventory: { log: 2, torch: 1 },
      flags: ["scout_ready"],
      customChecks: { b: false },
    };

    const merged = mergeRequirementContexts(base, override);

    expect(merged.abilities).toEqual({ str: 10, dex: 10 });
    expect(merged.skillLevels).toEqual({ logging: 2, wood_craft: 1 });
    expect(merged.inventory).toEqual({ log: 3, torch: 1 });
    expect(merged.flags).toBeInstanceOf(Set);
    expect(Array.from(merged.flags!)).toEqual(
      expect.arrayContaining(["forest_access", "scout_ready"]),
    );
    expect(merged.customChecks).toMatchObject({ a: true, b: false });
    expect(merged.resolveCustom?.("always_true", merged)).toBe(true);
  });

  it("subtracts inventory when subtractInventory is true", () => {
    const base = { inventory: { log: 5, torch: 1 } };
    const override = { inventory: { log: 2, torch: 1, plank: 3 } };
    const options: MergeRequirementContextOptions = { subtractInventory: true };

    const merged = mergeRequirementContexts(base, override, options);
    expect(merged.inventory).toEqual({ log: 3, torch: 0, plank: -3 });
  });
});

