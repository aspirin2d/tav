import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "./db/schema.js";
import { tavRoutes } from "./routes/tav.js";
import { inventoryRoutes } from "./routes/inventory.js";
import { taskRoutes } from "./routes/tasks.js";
import { jsonError } from "./routes/util.js";

const client = new PGlite(process.env.DATABASE_URL!);
const db = drizzle({ client, schema: schema });

const app = new Hono();

// Request logging
app.use("*", logger());

app.onError((err, c) => {
  // Standard JSON error envelope for unhandled errors
  console.error("Unhandled error:", err);
  return jsonError(c, err?.message ?? "internal_error", 500, "internal_error");
});

app.get("/", async (c) => {
  const [res] = await db.insert(schema.visitLog).values({}).returning();
  return c.text(
    `Hello Hono: visit ${res.id} times. ${res.createdAt.toISOString()}`,
  );
});

// API routes
app.route("/tav", tavRoutes(db));
app.route("/tav/:tavId/inventory", inventoryRoutes(db));
app.route("/tav/:tavId/tasks", taskRoutes(db));

serve(
  {
    fetch: app.fetch,
    port: 3000,
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  },
);
