import { describe, it, expect } from "vitest";

import { mergeCompletionEffects } from "./task.js";

describe("task internals: mergeCompletionEffects", () => {
  it("returns null when inventory entries sum to zero or are zero", () => {
    const effect = mergeCompletionEffects({ inventory: { log: 0 } });
    expect(effect).toBeNull();
  });

  it("drops zero-delta items and keeps non-zero ones", () => {
    const effect = mergeCompletionEffects({ inventory: { log: 1, plank: 0 } });
    expect(effect).toEqual({ inventory: { log: 1 } });
  });
});

