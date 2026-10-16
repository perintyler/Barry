import type { ToolCallBounds } from "@barry-rocks/sdk/bounds";
import { currentTarget } from "./target.js";
import { Sessions } from "@barry-rocks/sessions-bag/client";

/** Durable run ownership survives identity renames; unknown ownership permits nothing. */
export async function ownsActionRun(run: {
  session_id: string | null;
  metadata: Record<string, unknown>;
}): Promise<boolean> {
  const target = currentTarget();
  if (target.kind === "system") return true;
  if (typeof run.metadata.identity_id === "number")
    return run.metadata.identity_id === target.binding.id;
  if (!run.session_id) return false;
  const session = await Sessions.get(run.session_id);
  return session?.identity_id === target.binding.id;
}
export async function assertOwnedActionRun(run: {
  session_id: string | null;
  metadata: Record<string, unknown>;
}): Promise<void> {
  if (!(await ownsActionRun(run)))
    throw new Error("action run does not belong to this identity");
}
export function runOwnerMetadata(): Record<string, unknown> {
  const target = currentTarget();
  return target.kind === "identity" ? { identity_id: target.binding.id } : {};
}
export function ownsSchedule(identity: string | undefined): boolean {
  const target = currentTarget();
  return target.kind === "system" || identity === target.name;
}
export function assertOwnedSchedule(identity: string | undefined): void {
  if (!ownsSchedule(identity))
    throw new Error("schedule does not belong to this identity");
}
export async function filterOwnedRuns<
  T extends { session_id: string | null; metadata: Record<string, unknown> },
>(runs: T[]): Promise<T[]> {
  const owned = await Promise.all(runs.map(ownsActionRun));
  return runs.filter((_run, index) => owned[index]);
}

export function runSecretTarget(): { kind: "identity"; id: number } | { kind: "installation" } {
  const target = currentTarget();
  return target.kind === "identity" ? { kind: "identity", id: target.binding.id } : { kind: "installation" };
}

/** Selected schedule bounds and caller restrictions remain ceilings on identity tools. */
export async function withRunBounds<T>(operation: () => Promise<T>, selected?: ToolCallBounds): Promise<T> {
  const system = currentTarget().kind === "system";
  if (system && !selected) return operation();
  const [{ authorizeIdentityTool }, { currentStoreContext, withStoreContext }, { mergeBounds }] = await Promise.all([
    import("./tool-bounds.js"), import("@barry-rocks/sdk/internal/stores"), import("@barry-rocks/sdk/bounds"),
  ]);
  const callerBounds = system ? selected! : await authorizeIdentityTool({ namespace: "bash", name: "Bash", access: "write" });
  const existing = currentStoreContext();
  if (existing?.identity && callerBounds.identity && existing.identity !== callerBounds.identity) throw new Error("script identity does not match the caller");
  if (selected?.identity && callerBounds.identity && selected.identity !== callerBounds.identity) throw new Error("schedule identity does not match the caller");
  let execution: ToolCallBounds = callerBounds;
  for (const ceiling of [selected, existing?.execution]) {
    if (!ceiling) continue;
    execution = {
      ...execution, bound: mergeBounds(execution.bound ?? null, ceiling.bound ?? null) ?? null,
      allowedToolIds: execution.allowedToolIds.filter((id: string) => ceiling.allowedToolIds.includes(id)),
    };
  }
  return withStoreContext({ ...existing, execution }, operation);
}

/** Raw children cannot enforce structured bounds after launch. */
export async function assertRawScriptBounds(): Promise<void> {
  const [{ currentStoreContext }, { boundHasContent }] = await Promise.all([
    import("@barry-rocks/sdk/internal/stores"), import("@barry-rocks/sdk/bounds"),
  ]);
  const execution = currentStoreContext()?.execution;
  if (execution && (boundHasContent(execution.bound ?? undefined) || !execution.allowedToolIds.includes("bash:Bash"))) {
    throw new Error("raw script execution requires an unbounded Bash tool from the caller's bounds");
  }
}
