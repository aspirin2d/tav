import { relations, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import z from "zod";

// ---------------------------------------------------------------------------
// Requirement DSL
// ---------------------------------------------------------------------------

export const slugSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9_]+$/, "must be snake_case");

const abilityIds = ["str", "dex", "con", "int", "wis", "cha"] as const;

export const abilityIdSchema = z.enum(abilityIds);

export type Requirement =
  | {
      op: "ability_min";
      ability: (typeof abilityIds)[number];
      value: number;
    }
  | {
      op: "tav_level_min";
      level: number;
    }
  | {
      op: "skill_level_min";
      skillId: string;
      level: number;
    }
  | {
      op: "item_required";
      itemId: string;
      quantity: number;
    }
  | {
      op: "flag_present";
      flagId: string;
    }
  | {
      op: "custom";
      name: string;
    }
  | {
      op: "and";
      requirements: Requirement[];
    }
  | {
      op: "or";
      requirements: Requirement[];
    }
  | {
      op: "not";
      requirement: Requirement;
    };

export const requirementSchema: z.ZodType<Requirement> = z.lazy(() =>
  z.discriminatedUnion("op", [
    z.object({
      op: z.literal("ability_min"),
      ability: abilityIdSchema,
      value: z.int().min(0).max(30),
    }),
    z.object({
      op: z.literal("tav_level_min"),
      level: z.int().min(1),
    }),
    z.object({
      op: z.literal("skill_level_min"),
      skillId: slugSchema,
      level: z.int().min(1),
    }),
    z.object({
      op: z.literal("item_required"),
      itemId: slugSchema,
      quantity: z.int().min(1),
    }),
    z.object({
      op: z.literal("flag_present"),
      flagId: slugSchema,
    }),
    z.object({
      op: z.literal("custom"),
      name: slugSchema,
    }),
    z.object({
      op: z.literal("and"),
      requirements: z.array(requirementSchema).min(1),
    }),
    z.object({
      op: z.literal("or"),
      requirements: z.array(requirementSchema).min(1),
    }),
    z.object({
      op: z.literal("not"),
      requirement: requirementSchema,
    }),
  ]),
);

export type RequirementEvaluationContext = {
  abilities?: Partial<Record<(typeof abilityIds)[number], number>>;
  tavLevel?: number;
  skillLevels?: Record<string, number>;
  inventory?: Record<string, number>;
  flags?: Iterable<string>;
  customChecks?: Record<
    string,
    boolean | ((context: RequirementEvaluationContext) => boolean)
  >;
  resolveCustom?: (
    name: string,
    context: RequirementEvaluationContext,
  ) => boolean | undefined;
};

export function evaluateRequirements(
  requirements: Requirement[],
  context: RequirementEvaluationContext,
): boolean {
  if (requirements.length === 0) {
    return true;
  }

  return requirements.every((requirement) => {
    switch (requirement.op) {
      case "ability_min": {
        const score = context.abilities?.[requirement.ability] ?? 0;
        return score >= requirement.value;
      }
      case "skill_level_min": {
        const level = context.skillLevels?.[requirement.skillId] ?? 0;
        return level >= requirement.level;
      }
      case "tav_level_min": {
        const level = context.tavLevel ?? 1;
        return level >= requirement.level;
      }
      case "item_required": {
        const qty = readInventory(context.inventory, requirement.itemId);
        return qty >= requirement.quantity;
      }
      case "flag_present": {
        return hasInIterable(context.flags, requirement.flagId);
      }
      case "custom": {
        const handler = context.customChecks?.[requirement.name];
        if (typeof handler === "function") {
          return handler(context);
        }
        if (typeof handler === "boolean") {
          return handler;
        }
        const resolved = context.resolveCustom?.(requirement.name, context);
        return resolved ?? false;
      }
      case "and": {
        return evaluateRequirements(requirement.requirements, context);
      }
      case "or": {
        return requirement.requirements.some((inner) =>
          evaluateRequirements([inner], context),
        );
      }
      case "not": {
        return !evaluateRequirements([requirement.requirement], context);
      }
    }
  });
}

function readInventory(
  inventory: RequirementEvaluationContext["inventory"],
  itemId: string,
): number {
  if (!inventory) {
    return 0;
  }

  return inventory[itemId] ?? 0;
}

function hasInIterable(
  iterable: Iterable<string> | undefined,
  value: string,
): boolean {
  if (!iterable) {
    return false;
  }

  if (iterable instanceof Set) {
    return iterable.has(value);
  }

  for (const entry of iterable) {
    if (entry === value) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Config schemas
// ---------------------------------------------------------------------------

export const abilityScoresSchema = z.object({
  str: z.int().min(0).max(30),
  dex: z.int().min(0).max(30),
  con: z.int().min(0).max(30),
  int: z.int().min(0).max(30),
  wis: z.int().min(0).max(30),
  cha: z.int().min(0).max(30),
});

const labeledDefinitionSchema = z.object({
  id: slugSchema,
  name: z.string().min(1),
  description: z.string().min(1),
});

const rawItemDefinitionSchema = labeledDefinitionSchema.extend({
  stack_limit: z.int().min(1).max(999).default(99),
  weight: z.int().min(0).max(1000).default(0),
  value: z.int().min(0).max(1_000_000).default(0),
  tags: z.array(slugSchema).default([]),
});

export const itemDefinitionSchema = rawItemDefinitionSchema.transform(
  ({ stack_limit, ...rest }) => ({
    ...rest,
    stackLimit: stack_limit,
  }),
);

export const TASK_TARGETLESS_KEY = "null";

const completionEffectValueSchema = z.object({
  tav_xp: z.int().optional(),
  skill_xp: z.int().optional(),
  inventory: z.record(z.string(), z.int()).optional(),
});

const completionEffectOverrideSchema = z.record(
  slugSchema,
  completionEffectValueSchema,
);

const completionEffectSchema = completionEffectValueSchema.extend({
  target_overrides: completionEffectOverrideSchema.optional(),
});

type CompletionEffectValueInput = z.infer<typeof completionEffectValueSchema>;
type CompletionEffectInput = z.infer<typeof completionEffectSchema>;

type CompletionEffectValue = {
  tavXp?: number;
  skillXp?: number;
  inventory?: Record<string, number>;
};

export type CompletionEffect = CompletionEffectValue & {
  targetOverrides?: Record<string, CompletionEffectValue>;
};

function transformCompletionEffectValue(
  value: CompletionEffectValueInput | undefined,
): CompletionEffectValue | undefined {
  if (!value) {
    return undefined;
  }

  const result: CompletionEffectValue = {};

  if (typeof value.tav_xp === "number") {
    result.tavXp = value.tav_xp;
  }

  if (typeof value.skill_xp === "number") {
    result.skillXp = value.skill_xp;
  }

  if (value.inventory) {
    const entries = Object.entries(value.inventory).filter(
      ([, qty]) => qty !== 0,
    );
    if (entries.length > 0) {
      result.inventory = Object.fromEntries(entries);
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function transformCompletionEffect(
  effect: CompletionEffectInput | undefined,
): CompletionEffect | undefined {
  if (!effect) {
    return undefined;
  }

  const { target_overrides, ...rest } = effect;
  const base = transformCompletionEffectValue(rest);

  const overrides = target_overrides
    ? Object.fromEntries(
        Object.entries(
          target_overrides as Record<string, CompletionEffectValueInput>,
        )
          .map(([targetId, value]) => {
            const transformed = transformCompletionEffectValue(value);
            return transformed ? [targetId, transformed] : null;
          })
          .filter(
            (entry): entry is [string, CompletionEffectValue] => entry !== null,
          ),
      )
    : undefined;

  const hasOverrides = overrides && Object.keys(overrides).length > 0;

  if (!base && !hasOverrides) {
    return undefined;
  }

  if (hasOverrides) {
    return base
      ? { ...base, targetOverrides: overrides }
      : { targetOverrides: overrides };
  }

  return base;
}

const rawSkillDefinitionSchema = labeledDefinitionSchema.extend({
  priority: z.int().min(1).max(9).default(5),
  duration: z.int().min(1500).max(5000).default(2000),
  targets: z.array(slugSchema).default([]),
  add_requirements: z.array(requirementSchema).default([]),
  execute_requirements: z.array(requirementSchema).default([]),
  completion_effect: completionEffectSchema.optional(),
});

export const skillDefinitionSchema = rawSkillDefinitionSchema.transform(
  ({
    targets,
    add_requirements,
    execute_requirements,
    completion_effect,
    ...rest
  }) => ({
    ...rest,
    targetIds: targets,
    addRequirements: add_requirements,
    executeRequirements: execute_requirements,
    completionEffect: transformCompletionEffect(completion_effect),
  }),
);

export const targetDefinitionSchema = labeledDefinitionSchema
  .extend({
    add_requirements: z.array(requirementSchema).default([]),
    execute_requirements: z.array(requirementSchema).default([]),
    completion_effect: completionEffectValueSchema.optional(),
    skills: z.array(slugSchema).default([]),
  })
  .transform(
    ({
      add_requirements,
      execute_requirements,
      completion_effect,
      skills,
      ...rest
    }) => ({
      ...rest,
      addRequirements: add_requirements,
      executeRequirements: execute_requirements,
      completionEffect: transformCompletionEffectValue(completion_effect),
      skills,
    }),
  );

export type AbilityScores = z.infer<typeof abilityScoresSchema>;
export type ItemDefinition = z.infer<typeof itemDefinitionSchema>;
export type SkillDefinition = z.infer<typeof skillDefinitionSchema>;
export type TargetDefinition = z.infer<typeof targetDefinitionSchema>;

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export const visitLog = pgTable("visit_log", {
  id: serial().primaryKey(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const tav = pgTable(
  "tav",
  {
    id: serial().primaryKey(),
    name: text("name").notNull(),
    abilityScores: jsonb("ability_scores").$type<AbilityScores>().notNull(),
    flags: jsonb("flags")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    hpCurrent: integer("hp_current").notNull().default(10),
    hpTemp: integer("hp_temp").notNull().default(0),
    hpMax: integer("hp_max").notNull().default(10),
    xp: integer("xp").notNull().default(0),
    xpLevel: smallint("xp_level").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check("tav_hp_current_le_max", sql`${table.hpCurrent} <= ${table.hpMax}`),
  ],
);

export const skill = pgTable(
  "skill",
  {
    id: text("id").notNull(),
    tavId: integer("tav_id")
      .notNull()
      .references(() => tav.id, { onDelete: "cascade" }),
    xp: integer("xp").notNull().default(0),
    xpLevel: smallint("xp_level").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.id, table.tavId] })],
);

export const inventory = pgTable(
  "inventory",
  {
    tavId: integer("tav_id")
      .notNull()
      .references(() => tav.id, { onDelete: "cascade" }),
    slot: smallint("slot").notNull(),
    itemId: text("item_id").notNull(),
    qty: smallint("qty").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: false })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.slot, table.tavId] }),
    index("idx_tav_inv_tav").on(table.tavId),
    index("idx_tav_inv_item").on(table.itemId),
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
    tavId: integer("tav_id")
      .notNull()
      .references(() => tav.id, { onDelete: "cascade" }),
    skillId: text("skill_id").notNull(),
    targetId: text("target_id").notNull(),
    status: taskStatusEnum("status").notNull().default("pending"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
  },
  (table) => [
    primaryKey({ columns: [table.tavId, table.skillId, table.targetId] }),
    index("idx_task_tav").on(table.tavId),
    uniqueIndex("uniq_task_executing")
      .on(table.tavId)
      .where(sql`${table.status} = 'executing'`),
    foreignKey({
      name: "skill",
      columns: [table.skillId, table.tavId],
      foreignColumns: [skill.id, skill.tavId],
    }).onDelete("cascade"),
  ],
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const tavRelations = relations(tav, ({ many }) => ({
  tasks: many(task),
  skills: many(skill), // skill info(eg: xp, level...)
  inventory: many(inventory),
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
