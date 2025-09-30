import { describe, expect, it } from "vitest";

import { scheduleFlag } from "./schedule.js";

describe("scheduleFlag", () => {
  it("produces snake_case slugs per block id", () => {
    expect(scheduleFlag("work")).toBe("schedule_block_work");
    expect(scheduleFlag("downtime")).toBe("schedule_block_downtime");
    expect(scheduleFlag("bedtime")).toBe("schedule_block_bedtime");
    expect(scheduleFlag("bathtime")).toBe("schedule_block_bathtime");
  });
});

