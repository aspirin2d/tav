import { ITEM_DEFINITIONS } from "../config.js";
import type { ItemDefinition } from "../db/schema.js";

// Cache item definitions in a Map for O(1) lookups by id.
const ITEM_DEFINITION_MAP = new Map<string, ItemDefinition>(
  ITEM_DEFINITIONS.map((definition) => [definition.id, definition]),
);

/** Returns the ItemDefinition for an id, or null when unknown. */
export function getItemDefinition(itemId: string): ItemDefinition | null {
  return ITEM_DEFINITION_MAP.get(itemId) ?? null;
}

/** Like getItemDefinition, but throws for unknown ids (useful for invariants). */
export function requireItemDefinition(itemId: string): ItemDefinition {
  const definition = getItemDefinition(itemId);
  if (!definition) {
    throw new Error(`Unknown item id: ${itemId}`);
  }
  return definition;
}

/** Convenience: reads the configured per-item stack limit. */
export function getStackLimit(itemId: string): number {
  return requireItemDefinition(itemId).stackLimit;
}
