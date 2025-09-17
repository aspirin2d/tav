import { pgTable, serial, timestamp } from "drizzle-orm/pg-core";

export const visitLog = pgTable("visit_log", {
  id: serial().primaryKey(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
