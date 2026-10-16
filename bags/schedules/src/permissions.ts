import { Barry, isBarryError, type Bound, type Tool } from "@barry-rocks/sdk";
import { qualifyToolId } from "@barry-rocks/sdk/bounds";
import { installationRegistry } from "@barry-rocks/sdk/internal/nodes";
import { normalizeSchedule } from "@barry-rocks/sdk/internal/schedules";
import type { AtSchedule } from "./at-schedules.js";
import type { ScheduleEntry } from "./registry.js";

export interface ScheduleAccess {
  identity?: string;
  bags: string[];
  bound: Bound | null;
  tools: Tool[];
  allowedToolIds: string[];
  harness?: string;
}

export function assertScheduleSelection(
  schedule: Pick<ScheduleEntry["schedule"], "identity" | "bags">,
  id: string,
): void {
  const bags = schedule.bags;
  if (!schedule.identity && !bags?.length) {
    throw new Error(`${id}: an identity-free schedule must explicitly select bags`);
  }
}

/**
 * What a schedule runs with: the bags and bounds of the identity it names (by
 * name or by its installation-stable id, as its stored row keeps it), with the
 * bags and bounds it selects on top. Never the installation's defaults: a
 * schedule is granted only what it names.
 */
export async function resolveScheduleAccess(
  entry: ScheduleEntry,
  harness?: string,
): Promise<ScheduleAccess> {
  assertScheduleSelection(entry.schedule, entry.id);
  const rawBags = entry.schedule.bags ?? [];
  const rawBounds = [...(entry.schedule.bounds ?? [])];
  const bags: string[] = [];
  for (const item of rawBags) {
    if (item.endsWith(":read") && item.length > ":read".length) {
      const clean = item.slice(0, -":read".length);
      if (!bags.includes(clean)) bags.push(clean);
      if (!rawBounds.includes(item)) rawBounds.push(item);
    } else if (!bags.includes(item)) {
      bags.push(item);
    }
  }
  const named = entry.schedule.identity ? Barry.identity(entry.schedule.identity) : null;
  const identity = named ? await refusedAs(named.get(), "unknown schedule identity") : null;
  const identityRef = entry.schedule.identity ?? null;
  const bound = await refusedAs(
    Promise.resolve(Barry.bound(identityRef, rawBounds)),
    "invalid schedule permissions",
  );
  const tools = await refusedAs(
    Promise.resolve(Barry.tools(identityRef, bags, rawBounds)),
    "invalid schedule permissions",
  );
  return {
    identity: identity ? installationRegistry().identityId(identity.id) : undefined,
    bags,
    bound: bound ?? null,
    tools,
    allowedToolIds: tools.map((tool) => qualifyToolId(tool.namespace, tool.name)),
    harness,
  };
}

/** A schedule names what is wrong with it; a Barry that cannot answer at all says so itself. */
async function refusedAs<T>(answer: Promise<T>, what: string): Promise<T> {
  try {
    return await answer;
  } catch (error) {
    if (isBarryError(error) && error.reason !== "unavailable") {
      throw new Error(`${what}: ${error.message}`);
    }
    throw error;
  }
}

export function resolveAtScheduleAccess(scheduleItem: AtSchedule, harness?: string): Promise<ScheduleAccess> {
  const schedule = normalizeSchedule(
    scheduleItem.id,
    { at: scheduleItem.dueAt.toISOString(), action: scheduleItem.action ?? "inline", ...scheduleItem.permissions },
    ".",
    scheduleItem.id,
  );
  return resolveScheduleAccess(
    { id: scheduleItem.id, bag: scheduleItem.bag, name: scheduleItem.id, dir: ".", schedule },
    harness,
  );
}

export const scheduleContext = resolveScheduleAccess;
