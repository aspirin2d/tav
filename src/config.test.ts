import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("node:fs");
});

describe("DEFAULT_TAV_ABILITY_SCORES", () => {
  it("throws when config file cannot be read", async () => {
    vi.doMock("node:fs", () => ({
      readFileSync: () => {
        const error = new Error("not found");
        throw error;
      },
    }));

    await expect(import("./config.js")).rejects.toThrow(/not found/);
  });

  it("reads ability score overrides from config", async () => {
    vi.doMock("node:fs", () => ({
      readFileSync: () =>
        [
          "[defaults.ability_scores]",
          "str = 12",
          "dex = 10",
          "con = 11",
          "int = 13",
          "wis = 14",
          "cha = 9",
        ].join("\n"),
    }));

    const { DEFAULT_TAV_ABILITY_SCORES } = await import("./config.js");

    expect(DEFAULT_TAV_ABILITY_SCORES).toEqual({
      str: 12,
      dex: 10,
      con: 11,
      int: 13,
      wis: 14,
      cha: 9,
    });
  });

  it("throws when config contains invalid values", async () => {
    vi.doMock("node:fs", () => ({
      readFileSync: () =>
        [
          "[defaults.ability_scores]",
          "str = \"bad\"",
          "dex = 10",
          "con = 11",
          "int = 13",
          "wis = 14",
          "cha = 9",
        ].join("\n"),
    }));

    await expect(import("./config.js")).rejects.toThrow();
  });

  it("throws when ability scores exceed allowed range", async () => {
    vi.doMock("node:fs", () => ({
      readFileSync: () =>
        [
          "[defaults.ability_scores]",
          "str = 40",
          "dex = 10",
          "con = 11",
          "int = 13",
          "wis = 14",
          "cha = 9",
        ].join("\n"),
    }));

    await expect(import("./config.js")).rejects.toThrow();
  });
});
