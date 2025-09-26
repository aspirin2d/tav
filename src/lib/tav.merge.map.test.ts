import { describe, expect, it } from "vitest";

import { mergeRequirementContexts } from "./tav.js";

describe("mergeRequirementContexts with Map inventory and empty flags", () => {
  it("accepts Map inputs for base and override and returns undefined flags when empty", () => {
    const base = {
      inventory: new Map<string, number>([
        ["log", 2],
        ["torch", 1],
      ]),
      // no flags
    };

    const override = {
      inventory: new Map<string, number>([["log", 3]]),
      flags: undefined,
    };

    const merged = mergeRequirementContexts(base as any, override as any);
    expect(merged.inventory).toEqual({ log: 5, torch: 1 });
    expect(merged.flags).toBeUndefined();
  });
});

