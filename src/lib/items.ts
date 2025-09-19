import { ITEM_DEFINITIONS } from "../config.js";
import type { ItemDefinition } from "../db/schema.js";

const ITEM_DEFINITION_MAP = new Map<string, ItemDefinition>(
  ITEM_DEFINITIONS.map((definition) => [definition.id, definition]),
);

export function getItemDefinition(itemId: string): ItemDefinition | null {
  return ITEM_DEFINITION_MAP.get(itemId) ?? null;
}

export function requireItemDefinition(itemId: string): ItemDefinition {
  const definition = getItemDefinition(itemId);
  if (!definition) {
    throw new Error(`Unknown item id: ${itemId}`);
  }
  return definition;
}

export function getStackLimit(itemId: string): number {
  return requireItemDefinition(itemId).stackLimit;
}
