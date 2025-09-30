import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as schema from "../db/schema.js";
import { createTav, addTask } from "./tav.js";
import { tickTask } from "./task.js";
import { scheduleFlag } from "./schedule.js";

type DatabaseClient = PgliteDatabase<typeof schema>;

function migrationsPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return join(currentDir, "../../drizzle");
}

describe("task ticking schedule flag integration", () => {
  let client: PGlite;
  let db: DatabaseClient;

  beforeEach(async () => {
    client = new PGlite();
    db = drizzle({ client, schema });
    await migrate(db, { migrationsFolder: migrationsPath() });
  });

  afterEach(async () => {
    await client.close();
    vi.restoreAllMocks();
  });

  it("injects the current schedule flag into requirement context during evaluation", async () => {
    const t = await createTav(db, { name: "Flagged" }); // uses default schedule (block 0 = work)

    await addTask(db, { tavId: t.id, skillId: "meditate", targetId: null });

    const originalEval = schema.evaluateRequirements;
    let sawScheduleFlag = false;

    vi.spyOn(schema, "evaluateRequirements").mockImplementation((reqs, ctx) => {
      if (ctx?.flags) {
        for (const f of ctx.flags) {
          if (f === scheduleFlag("work")) {
            sawScheduleFlag = true;
            break;
          }
        }
      }
      return originalEval(reqs, ctx);
    });

    const out = await tickTask(db, {
      tavId: t.id,
      lastTickAt: new Date(0),
      now: new Date(10),
    });

    expect(sawScheduleFlag).toBe(true);
    expect(out.started).toContainEqual({
      tavId: t.id,
      skillId: "meditate",
      targetId: schema.TASK_TARGETLESS_KEY,
    });
  });
});

