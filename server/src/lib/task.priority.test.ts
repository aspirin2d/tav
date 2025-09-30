import { describe, expect, it } from "vitest";

import { priorityDeltaForBlock } from "./task.js";

describe("priorityDeltaForBlock (default)", () => {
  it("returns neutral (0) for all blocks by default", () => {
    expect(priorityDeltaForBlock("work")).toBe(0);
    expect(priorityDeltaForBlock("downtime")).toBe(0);
    expect(priorityDeltaForBlock("bedtime")).toBe(0);
    expect(priorityDeltaForBlock("bathtime")).toBe(0);
  });
});

