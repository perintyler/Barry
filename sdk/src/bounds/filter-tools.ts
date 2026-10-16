import type { Bound, ToolDescriptor } from "./types.js";
import {
  filterToolObjects,
  isToolAllowedByBound,
  matchesToolPattern,
  qualifyToolId,
} from "./tool-guards.js";

export { filterToolObjects, isToolAllowedByBound, matchesToolPattern, qualifyToolId };

/**
 * Filter tools by a `Bound`.
 * Returns the allowed tool names.
 */
export function filterTools(allTools: readonly ToolDescriptor[], bound?: Bound | null): string[] {
  return filterToolObjects(allTools, bound).map((tool) => tool.toolName);
}

/**
 * Filter tools by a `Bound`.
 * Returns qualified `namespace:toolName` identifiers.
 */
export function filterToolsQualified(allTools: readonly ToolDescriptor[], bound?: Bound | null): string[] {
  return filterToolObjects(allTools, bound).map((tool) =>
    qualifyToolId(tool.namespace, tool.toolName),
  );
}
