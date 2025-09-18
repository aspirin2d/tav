import { describe, expect, it } from "vitest";

import { evaluateRequirements, type Requirement } from "./schema.js";

describe("requirement evaluation", () => {
  it("treats an empty requirement list as satisfied", () => {
    const context = { abilities: { str: 10 } };
    expect(evaluateRequirements([], context)).toBe(true);
  });

  it("evaluates a single requirement when present", () => {
    const requirement: Requirement = {
      op: "ability_min",
      ability: "str",
      value: 12,
    };

    expect(
      evaluateRequirements([requirement], { abilities: { str: 13 } }),
    ).toBe(true);
    expect(
      evaluateRequirements([requirement], { abilities: { str: 10 } }),
    ).toBe(false);
  });
});
