import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "./db/schema.js";
const client = new PGlite(process.env.DATABASE_URL!);
const db = drizzle({ client, schema: schema });

const app = new Hono();

app.get("/", async (c) => {
  const [res] = await db.insert(schema.visitLog).values({}).returning();
  return c.text(`Hello Hono: ${res.id} ${res.createdAt.toISOString()}`);
});

serve(
  {
    fetch: app.fetch,
    port: 3000,
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  },
);
