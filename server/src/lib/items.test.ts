import { describe, expect, it } from "vitest";

import {
  getItemDefinition,
  getStackLimit,
  requireItemDefinition,
} from "./items.js";

describe("item definitions", () => {
  it("returns definitions for known items", () => {
    const log = getItemDefinition("log");
    expect(log).toBeTruthy();
    expect(log?.name).toBe("Log");
  });

  it("resolves stack limits and throws for unknown items", () => {
    expect(getStackLimit("torch")).toBeGreaterThan(0);

    expect(() => requireItemDefinition("unknown_item")).toThrow(
      /Unknown item id/,
    );
  });

  it("returns null for unknown lookups", () => {
    expect(getItemDefinition("mystery" )).toBeNull();
  });
});
