import type { ExecutionContext } from "@barry-rocks/sdk/bounds";
import { currentScope } from "./scope.js";
import { Sessions } from "@barry-rocks/sessions-bag/client";

/** Durable run ownership survives identity renames; unknown ownership grants nothing. */
export async function ownsActionRun(run: {
  session_id: string | null;
  metadata: Record<string, unknown>;
}): Promise<boolean> {
  const scope = currentScope();
  if (scope.kind === "system") return true;
  if (typeof run.metadata.identity_id === "number")
    return run.metadata.identity_id === scope.binding.id;
  if (!run.session_id) return false;
  const session = await Sessions.get(run.session_id);
  return session?.identity_id === scope.binding.id;
}
export async function assertOwnedActionRun(run: {
  session_id: string | null;
  metadata: Record<string, unknown>;
}): Promise<void> {
  if (!(await ownsActionRun(run)))
    throw new Error("action run does not belong to this identity");
}
export function runOwnerMetadata(): Record<string, unknown> {
  const scope = currentScope();
  return scope.kind === "identity" ? { identity_id: scope.binding.id } : {};
}
export function ownsSchedule(identity: string | undefined): boolean {
  const scope = currentScope();
  return scope.kind === "system" || identity === scope.name;
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

export function runSecretScope(): { kind: "identity"; id: number } | { kind: "installation" } {
  const scope = currentScope();
  return scope.kind === "identity" ? { kind: "identity", id: scope.binding.id } : { kind: "installation" };
}

/** Selected schedule policy and caller restrictions remain ceilings on identity grants. */
export async function withRunPolicy<T>(operation: () => Promise<T>, selected?: ExecutionContext): Promise<T> {
  const system = currentScope().kind === "system";
  if (system && !selected) return operation();
  const [{ authorizeIdentityTool }, { currentStoreContext, withStoreContext }, { mergeBounds }] = await Promise.all([
    import("./tool-policy.js"), import("@barry-rocks/sdk/internal/stores"), import("@barry-rocks/sdk/bounds"),
  ]);
  const policy = system ? selected! : await authorizeIdentityTool({ namespace: "bash", name: "Bash", access: "write" });
  const existing = currentStoreContext();
  if (existing?.identity && policy.identity && existing.identity !== policy.identity) throw new Error("script identity does not match the caller");
  if (selected?.identity && policy.identity && selected.identity !== policy.identity) throw new Error("schedule identity does not match the caller");
  let execution: ExecutionContext = policy;
  for (const ceiling of [selected, existing?.execution]) {
    if (!ceiling) continue;
    execution = {
      ...execution, bound: mergeBounds(execution.bound ?? null, ceiling.bound ?? null) ?? null,
      allowedToolIds: execution.allowedToolIds.filter(id => ceiling.allowedToolIds.includes(id)),
    };
  }
  return withStoreContext({ ...existing, execution }, operation);
}

/** Raw children cannot enforce structured bounds after launch. */
export async function assertRawScriptPolicy(): Promise<void> {
  const [{ currentStoreContext }, { boundHasContent }] = await Promise.all([
    import("@barry-rocks/sdk/internal/stores"), import("@barry-rocks/sdk/bounds"),
  ]);
  const execution = currentStoreContext()?.execution;
  if (execution && (boundHasContent(execution.bound ?? undefined) || !execution.allowedToolIds.includes("bash:Bash"))) {
    throw new Error("raw script execution requires an unbounded Bash grant from the caller's execution policy");
  }
}
