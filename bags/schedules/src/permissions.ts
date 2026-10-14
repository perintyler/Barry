import { Barry, isBarryError, type GrantSelection } from "@barry-rocks/sdk";
import { qualifyToolId, type ExecutionContext } from "@barry-rocks/sdk/bounds";
import { installationRegistry } from "@barry-rocks/sdk/internal/nodes";
import { normalizeSchedule } from "@barry-rocks/sdk/internal/schedules";
import type { OneOff } from "./one-offs.js";
import type { ScheduleEntry } from "./catalog.js";
export function assertScheduleSelection(schedule: Pick<ScheduleEntry["schedule"], "identity" | "traits">, id: string): void {
    if (!schedule.identity && !schedule.traits?.length)
        throw new Error(`${id}: an identity-free schedule must explicitly select traits`);
}
/**
 * What a schedule runs with: the grants of the identity it names (by name or
 * by its installation-stable id, as its stored row keeps it), with the traits
 * and bounds it selects on top. Never the installation's defaults: a schedule
 * is granted only what it names.
 */
export async function scheduleContext(entry: ScheduleEntry, harness?: string): Promise<ExecutionContext> {
    const selected = entry.schedule.traits ?? [];
    assertScheduleSelection(entry.schedule, entry.id);
    const selection: GrantSelection = { traits: selected, ...(harness ? { harness } : {}), bounds: entry.schedule.bounds ?? [], defaults: false };
    const named = entry.schedule.identity ? Barry.identity(entry.schedule.identity) : null;
    const identity = named ? await refusedAs(named.get(), "unknown schedule identity") : null;
    const grants = await refusedAs(named ? named.grants(selection) : Barry.grants(selection), "invalid schedule permissions");
    return {
        identity: identity ? installationRegistry().identityId(identity.id) : undefined,
        traits: grants.traits,
        bound: grants.bound,
        allowedToolIds: grants.tools.map((tool) => qualifyToolId(tool.namespace, tool.name)),
        harness,
    };
}
/** A schedule names what is wrong with it; a Barry that cannot answer at all says so itself. */
async function refusedAs<T>(answer: Promise<T>, what: string): Promise<T> {
    try {
        return await answer;
    }
    catch (error) {
        if (isBarryError(error) && error.reason !== "unavailable")
            throw new Error(`${what}: ${error.message}`);
        throw error;
    }
}
export function oneOffContext(oneOff: OneOff, harness?: string): Promise<ExecutionContext> {
    const schedule = normalizeSchedule(oneOff.id, { at: oneOff.dueAt.toISOString(), action: oneOff.action ?? "inline", ...oneOff.permissions }, ".", oneOff.id);
    return scheduleContext({ id: oneOff.id, bag: oneOff.bag, name: oneOff.id, dir: ".", schedule }, harness);
}
