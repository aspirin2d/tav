import { relations, sql } from "drizzle-orm";
import {
  check,
  integer,
  smallint,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  index,
  pgEnum,
} from "drizzle-orm/pg-core";
import z from "zod";

// a test table
export const visitLog = pgTable("visit_log", {
  id: serial().primaryKey(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const abilityScoresSchema = z.object({
  str: z.int().min(0).max(30),
  dex: z.int().min(0).max(30),
  con: z.int().min(0).max(30),
  int: z.int().min(0).max(30),
  wis: z.int().min(0).max(30),
  cha: z.int().min(0).max(30),
});

export type AbilityScores = z.infer<typeof abilityScoresSchema>;

export const tav = pgTable(
  "tav",
  {
    id: serial().primaryKey(),
    name: text("name").notNull(),
    abilityScores: jsonb("ability_scores").$type<AbilityScores>().notNull(),
    hpCurrent: integer("hp_current").notNull().default(10),
    hpTemp: integer("hp_temp").notNull().default(0),
    hpMax: integer("hp_max").notNull().default(10),
    xp: integer("xp").notNull().default(0),
    xpLevel: smallint("xp_level").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    check("tav_hp_current_le_max", sql`${table.hpCurrent} <= ${table.hpMax}`),
  ],
);

export const skill = pgTable(
  "skill",
  {
    id: serial().primaryKey(),
    tavId: integer("tav_id")
      .notNull()
      .references(() => tav.id, { onDelete: "cascade" }),
    skillId: text("skill_id").notNull(),
    xp: integer("xp").notNull().default(0),
    xpLevel: smallint("xp_level").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("uniq_tav_skill").on(table.tavId, table.skillId)],
);

export const inventory = pgTable(
  "inventory",
  {
    id: serial().primaryKey(),
    tavId: integer("tav_id")
      .notNull()
      .references(() => tav.id, { onDelete: "cascade" }),
    slot: smallint("slot").notNull(), // 0-based slot index
    itemId: text("item_id").notNull(),
    qty: smallint("qty").notNull().default(1), // 1..stackMax
    createdAt: timestamp("created_at", { withTimezone: false })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // one stack per (duplicant, slot)
    uniqueIndex("uniq_tav_slot").on(t.tavId, t.slot),
    index("idx_tav_inv_tav").on(t.tavId),
    index("idx_tav_inv_item").on(t.itemId),
  ],
);

export const taskStatusEnum = pgEnum("task_status", [
  "pending",
  "executing",
  "failed",
]);

export const task = pgTable(
  "task",
  {
    id: serial().primaryKey(),
    tavId: integer("tav_id")
      .notNull()
      .references(() => tav.id, { onDelete: "cascade" }),
    skillId: text("skill_id").notNull(),
    status: taskStatusEnum("status").notNull().default("pending"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    executedAt: timestamp("executed_at"), // last executed time
  },
  (table) => [
    index("idx_task_tav").on(table.tavId),
    index("idx_task_skill").on(table.skillId),
    uniqueIndex("uniq_task_executing")
      .on(table.tavId)
      .where(sql`${table.status} = 'executing'`),
  ],
);

export const tavRelations = relations(tav, ({ many }) => ({
  skills: many(skill),
  inventory: many(inventory),
  tasks: many(task),
}));

export const tavSkillRelations = relations(skill, ({ one }) => ({
  tav: one(tav, {
    fields: [skill.tavId],
    references: [tav.id],
  }),
}));

export const tavInventoryRelations = relations(inventory, ({ one }) => ({
  tav: one(tav, {
    fields: [inventory.tavId],
    references: [tav.id],
  }),
}));

export const tavTaskRelations = relations(task, ({ one }) => ({
  tav: one(tav, {
    fields: [task.tavId],
    references: [tav.id],
  }),
}));
