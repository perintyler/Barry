/** Top-level command classification drives help and completion; root-surface tests compare it with actual Commander registrations. */

export type HelpGroup =
  | "working"       // start/resume/run a session
  | "setup"         // configure the active identity
  | "capabilities"  // bags: install, author, and their tools
  | "machine"       // this-machine devops operations
  | "files";        // trash/archive

/** Namespace entries classify help containers without adding them to either package command set. See docs/decisions/0041-command-classification-and-completion.md. */
export type Ship = "publishable" | "devops" | "namespace";

export interface CommandSpec {
  /** The registered top-level command name. */
  name: string;
  /** Which section of `barry --help` this appears under. Display only. */
  group: HelpGroup;
  /** Which package this ships in (devops.ts's PUBLISHABLE vs DEVOPS split). */
  ship: Ship;
}

/** Classify static root commands; root-surface tests compare actual Commander registrations. See docs/decisions/0041-command-classification-and-completion.md. */
export const COMMAND_REGISTRY: readonly CommandSpec[] = [
  { name: "workers", group: "machine", ship: "publishable" },
  { name: "device", group: "machine", ship: "publishable" },
  { name: "session", group: "working", ship: "publishable" },
  { name: "tool", group: "working", ship: "publishable" },
  // "run" is the old name of "tool", kept as a hidden alias for one release.
  { name: "run", group: "working", ship: "publishable" },
  { name: "acp", group: "working", ship: "publishable" },

  // ── Setup: the active identity and its configuration ─────────────────────
  // Identity verbs belong to this namespace; only actual root names are classified here.
  // See docs/decisions/0041-command-classification-and-completion.md.
  { name: "identity", group: "setup", ship: "namespace" },
  // "ls" is the permanent, visible alias for `identity list` (locked
  // decision) — kept for muscle memory, never removed.
  { name: "ls", group: "setup", ship: "publishable" },
  // "list" and "delete" are the two permanently RESERVED names (locked
  // decision) — the highest-risk generic names a bag could otherwise
  // silently claim once their aliases were gone. Unlike every other moved
  // verb, these keep a hidden top-level registration forever: it blocks a
  // bag from taking the name, and errors with guidance rather than
  // forwarding — see reserved-names.ts's own doc comment for why blocking
  // beats either silent forwarding or a bare "unknown command".
  { name: "list", group: "setup", ship: "publishable" },
  { name: "delete", group: "setup", ship: "publishable" },
  // "doctor" stays a root-level command in its own right (locked decision):
  // it reports on ALL identities, not the active one, and has no --name — it
  // never fit the per-identity verb pattern the other 20 did.
  { name: "doctor", group: "setup", ship: "publishable" },
  { name: "use", group: "setup", ship: "publishable" },
  { name: "alias", group: "setup", ship: "publishable" },
  { name: "vault", group: "setup", ship: "publishable" },
  { name: "config", group: "setup", ship: "publishable" },
  { name: "notify", group: "setup", ship: "publishable" },

  { name: "bag", group: "capabilities", ship: "publishable" },
  // Publishable: a user installing Barry needs to know which agent adapters
  // their machine can actually run, and the answer is per-machine.
  { name: "adapter", group: "capabilities", ship: "publishable" },
  { name: "install", group: "capabilities", ship: "publishable" },
  { name: "pack", group: "capabilities", ship: "publishable" },
  { name: "unpack", group: "capabilities", ship: "publishable" },
  { name: "new", group: "capabilities", ship: "publishable" },
  { name: "trait", group: "capabilities", ship: "publishable" },
  { name: "bound", group: "capabilities", ship: "publishable" },
  { name: "mcp", group: "capabilities", ship: "publishable" },
  { name: "action", group: "capabilities", ship: "publishable" },
  { name: "app", group: "capabilities", ship: "publishable" },
  { name: "schedule", group: "capabilities", ship: "publishable" },
  { name: "events", group: "capabilities", ship: "publishable" },
  { name: "track", group: "capabilities", ship: "publishable" },
  { name: "cursor", group: "capabilities", ship: "publishable" },
  { name: "heir", group: "capabilities", ship: "publishable" },

  // ── This machine: devops operations ───────────────────────────────────────
  // "devops" is `ship: "namespace"` — findBoundaryViolations (devops.ts)
  // special-cases the literal string "devops" as "the container, not a
  // command in either set". It still needs a registry entry so the grouped
  // help formatter can place it here instead of misreading "not classified"
  // as "must be a bag group discovered at runtime".
  //
  // The remaining devops commands (ios, redmark) are only
  // reachable as `devops <name>`; this registry classifies top-level commands.
  // The instance: run it, install it, and see what it runs and exposes. Any
  // installation has one, so these are publishable root commands, not devops.
  { name: "down", group: "machine", ship: "publishable" },
  { name: "up", group: "machine", ship: "publishable" },
  { name: "setup", group: "machine", ship: "publishable" },
  { name: "owner", group: "machine", ship: "publishable" },
  { name: "uninstall", group: "machine", ship: "publishable" },
  { name: "upgrade", group: "machine", ship: "publishable" },
  { name: "status", group: "machine", ship: "publishable" },
  { name: "store", group: "machine", ship: "publishable" },
  { name: "service", group: "machine", ship: "publishable" },
  { name: "hosting", group: "machine", ship: "publishable" },
  { name: "env", group: "machine", ship: "publishable" },
  { name: "db", group: "machine", ship: "publishable" },
  { name: "devops", group: "machine", ship: "namespace" },
  // Health inspection uses service status; there is no separate root health entry.
  // See docs/decisions/0041-command-classification-and-completion.md.

  { name: "trash", group: "files", ship: "publishable" },
  { name: "archive", group: "files", ship: "publishable" },

  // ── Utilities (not shown as their own help section; listed for completion
  //    and boundary classification) ─────────────────────────────────────────
  { name: "completion", group: "capabilities", ship: "publishable" },
  { name: "__complete", group: "capabilities", ship: "publishable" },
  // Invoked by a VENDOR, from the hooks `barry track setup` writes into the
  // user's own config — never typed by a human, hence hidden. It still needs
  // classifying here: an unclassified command makes the boundary check print a
  // warning, and this one runs inside someone else's editor where stray output
  // on stdout is a parse error in their agent.
  { name: "hook", group: "capabilities", ship: "publishable" },
  // "help" is deliberately absent: it is Commander's own implicit command,
  // added to program.commands lazily at PARSE time (not by anything in
  // index.ts), so it was never really "ours" to classify. The grouped help
  // formatter (help-format.ts) renders it as a bare trailing line, matching
  // Commander's own default convention, rather than filing it under a
  // section here.
] as const;

/** All registered top-level names. What completion.ts's root fallback offers. */
export const ALL_COMMAND_NAMES: readonly string[] = COMMAND_REGISTRY.map((c) => c.name);

/** Names shipping in @barry-rocks/cli — devops.ts derives PUBLISHABLE_COMMANDS from this. */
export const PUBLISHABLE_NAMES: readonly string[] =
  COMMAND_REGISTRY.filter((c) => c.ship === "publishable").map((c) => c.name);

/** Names that stay devops-only — devops.ts derives DEVOPS_COMMANDS from this. */
export const DEVOPS_NAMES: readonly string[] =
  COMMAND_REGISTRY.filter((c) => c.ship === "devops").map((c) => c.name);

/** Commands grouped for display, in the order groups should render. */
export const HELP_GROUP_ORDER: readonly HelpGroup[] = [
  "working", "setup", "capabilities", "machine", "files",
];

export const HELP_GROUP_TITLES: Record<HelpGroup, string> = {
  working: "Working",
  setup: "Your setup",
  capabilities: "Capabilities",
  machine: "This machine",
  files: "Files",
};

/** Commands in a given help group, in the order they were declared above. */
export function commandsInGroup(group: HelpGroup): readonly CommandSpec[] {
  return COMMAND_REGISTRY.filter((c) => c.group === group);
}

/**
 * Reserve ambiguous list/delete names and direct callers to identity commands.
 * Actual root commands remain governed by COMMAND_REGISTRY.
 * See docs/decisions/0038-test-isolation-and-command-reservations.md.
 */
export const RESERVED_NAMES: ReadonlyMap<string, readonly string[]> = new Map([
  ["list", ["identity", "list"]],
  ["delete", ["identity", "delete"]],
]);
