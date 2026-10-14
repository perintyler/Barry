import type { Command } from "commander";
export interface IdentityBinding {
  id: number;
  home: string | null;
  directory?: string;
  instance?: string;
}
export const CLI_SCOPE = Symbol.for("barry.cli.scope");
export type CLIScope =
  | { kind: "system" }
  | { kind: "identity"; binding: IdentityBinding; name: string };
export function currentScope(): CLIScope {
  return (
    ((globalThis as Record<symbol, unknown>)[CLI_SCOPE] as CLIScope) ?? {
      kind: "system",
    }
  );
}
/** The executable the current command belongs to, including identity shims. */
export function cliName(): string {
  const scope = currentScope();
  return scope.kind === "identity" ? scope.name : "barry";
}
const SYSTEM = new Set([
  "status",
  "schedule",
  "store",
  "list",
  "delete",
  "heir",
  "cursor",
  "workers",
  "device",
  "owner",
  "identity",
  "ls",
  "doctor",
  "use",
  "alias",
  "config",
  "bag",
  "adapter",
  "install",
  "new",
  "trait",
  "bound",
  "app",
  "up",
  "down",
  "setup",
  "uninstall",
  "upgrade",
  "service",
  "hosting",
  "env",
  "db",
  "devops",
  "trash",
  "archive",
  "completion",
  "__complete",
]);
const IDENTITY = new Set([
  "status",
  "store",
  "session",
  "tool",
  "run",
  "acp",
  "identity",
  "vault",
  "notify",
  "bag",
  "install",
  "pack",
  "unpack",
  "mcp",
  "action",
  "schedule",
  "events",
  "track",
  "hook",
  "completion",
  "__complete",
]);
/** Filter registration itself, including mixed namespaces, so help and execution agree. */
export function applyCommandScope(
  program: Command,
  scope: CLIScope,
  bagGroups: Iterable<string> = [],
): void {
  const allowed =
    scope.kind === "system" ? SYSTEM : new Set([...IDENTITY, ...bagGroups]);
  (program.commands as Command[]).splice(
    0,
    program.commands.length,
    ...program.commands.filter((command) => allowed.has(command.name())),
  );
  const identity = program.commands.find(
    (command) => command.name() === "identity",
  );
  if (identity)
    (identity.commands as Command[]).splice(
      0,
      identity.commands.length,
      ...identity.commands.filter((command) =>
        scope.kind === "system"
          ? ["create", "list"].includes(command.name())
          : !["create", "list"].includes(command.name()),
      ),
    );
  const bag = program.commands.find((command) => command.name() === "bag");
  if (bag)
    (bag.commands as Command[]).splice(
      0,
      bag.commands.length,
      ...bag.commands.filter((command) =>
        scope.kind === "system"
          ? !["pack", "unpack", "auth"].includes(command.name())
          : ["pack", "unpack", "auth", "check"].includes(command.name()),
      ),
    );
  if (scope.kind === "system") {
    const schedule = program.commands.find(command => command.name() === "schedule");
    if (schedule) {
      (schedule.commands as Command[]).splice(0, schedule.commands.length, ...schedule.commands.filter(command => command.name() === "list"));
      (schedule as Command & { _defaultCommandName?: string })._defaultCommandName = undefined;
    }
    (
      program as Command & { _defaultCommandName?: string }
    )._defaultCommandName = undefined;
  } else program.name(scope.name);
}
export const IDENTITY_ONLY_COMMANDS = new Set(
  [...IDENTITY].filter((cmd) => !SYSTEM.has(cmd)),
);
export function isIdentityCommand(name: string): boolean {
  return IDENTITY_ONLY_COMMANDS.has(name);
}
export function isSystemCommand(name: string): boolean {
  return SYSTEM.has(name);
}
export function assertOwnedSession(
  session: { identity_id?: number | null } | undefined,
  identity: number,
): void {
  if (!session) throw new Error("session not found");
  if (session.identity_id !== identity)
    throw new Error("session belongs to another identity");
}
