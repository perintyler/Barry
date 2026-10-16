/**
 * Bag types for Barry's composable capability system.
 *
 * A bag provides tools, skills, bounds, and MCP server config.
 * Bags can be local directories with a manifest or remote MCP servers.
 */

import type { LiteralEnvValue } from "../services/literal-env.js";
import type { BagSchedule } from "../schedules/schedule-manifest.js";
import type { BagJob } from "./job-manifest.js";
import type { Bound } from "../bounds/index.js";

export type BagAccess = "read" | "readwrite";

/**
 * A bag's visibility in a session, set on its registry entry:
 * - `enabled`  — tools appear in the MCP tools/list normally (default)
 * - `deferred` — tools are hidden from tools/list but stay callable and
 *                discoverable via the `tool_search` tool
 * - `disabled` — the bag is off entirely (supersedes the legacy `disabled` bool)
 */
export type BagAccessLevel = "enabled" | "deferred" | "disabled";

/** Tool metadata declared in a bag manifest */
export interface BagToolMeta {
  toolName: string;
  namespace: string;
  access: BagAccess;
  /** Read from the tool's code (`toolContractHash`); absent for manifest and remote tools. */
  contractHash?: string;
  /** What the tool does, from its definition; absent for manifest and remote tools. */
  description?: string;
}

/** MCP server definition within a bag */
export interface BagMcpServer {
  type?: "http";
  url?: string;
  command?: string;
  args?: string[];
  env?: string[];
  /**
   * Give each Barry session its own connection to this server.
   *
   * Bag connections are normally pooled by `bagName:credentialHash` and
   * shared process-wide, which is right for stateless request/response servers
   * (an issue tracker, a docs search). It is wrong for a server that holds a
   * live artifact between calls — a browser tab, a running app — because every
   * session then drives the same one: navigating in one session moves the page
   * under another, and whatever is typed or logged into is visible across all
   * of them.
   *
   * Costs one server process per session, so only set it when the server is
   * genuinely stateful.
   */
  sessionScoped?: boolean;
}

/** Conventional local tool module discovered from the bag directory. */
export interface BagToolsEntry { entry: string }

/** A bag's computed prompt contributor (`prompts: { entry }`). */
export interface BagPromptsEntry {
  entry: string;
}

/**
 * CLI-delegated auth for a bag (`auth:` in bag.yaml).
 *
 * Some vendors ship their own OAuth in their CLI (e.g. `temporal cloud login`).
 * `barry bag auth <name>` runs `check` first (exit 0 → already authenticated),
 * then runs `command` interactively so the user can complete the browser flow.
 * Credentials stay in the vendor CLI's own store — no vault/barry env plumbing.
 */
export interface BagAuthCommand {
  command: string;
  args?: string[];
  /** Optional command that exits 0 when already authenticated */
  check?: {
    command: string;
    args?: string[];
  };
}

/**
 * Host binary a bag needs at runtime (e.g. `uvx` to launch an MCP server,
 * a CLI that in-process tools shell out to). Checked on PATH — missing
 * dependencies surface as warnings in `bag show`/`barry pack` and make the
 * MCP proxy fail fast instead of timing out silently.
 */
/**
 * A macOS privacy permission the bag's code needs, granted by a person in
 * System Settings › Privacy & Security. Declared so `barry bag doctor` can say
 * what to grant and to which program before a tool fails on a silent denial.
 */
export interface BagPermission {
  kind: "automation" | "accessibility" | "screen-recording" | "full-disk-access";
  /** For `automation`: the app it sends Apple events to, by name ("Pages"). */
  app?: string;
  /** What the bag needs it for. */
  reason: string;
}

export interface BagDependency {
  /** Host package key, which may differ from its executable name. */
  package?: string;
  optional?: boolean;
  /** Binary name looked up on PATH */
  name: string;
  /** Install command shown when the binary is missing (e.g. "brew install uv") */
  install?: string;
  /** What the bag needs it for */
  reason?: string;
}

/**
 * CLI configuration for a bag.
 *
 * Optional — only needed when the bag wants a different CLI command name
 * than its manifest `name`. Which bags actually appear in `barry -h` is
 * controlled by the user's `~/.config/barry/cli.yaml`, not the manifest.
 */
export interface BagCliConfig {
  /** Alternate CLI command group name (default: bag name). Used as: `barry <alias> <tool>` */
  alias?: string;
}

/**
 * A SLACK slash command declared in a bag manifest — `/oncall` typed into
 * Slack, dispatched to a handler exported from the entry module.
 *
 * NOT a coding-agent slash command. Those come from actions declaring
 * `slash_command: true` and are generated per session (see
 * `@barry-rocks/sdk/internal/actions` action-commands). The two are unrelated despite the
 * shared word, and the resemblance has already misled one reader into calling
 * this dead scaffolding.
 *
 * It is live: the slack-app bag imports each declaring bag's `entry` module at
 * startup (`slack-app/src/handlers/bag-commands.ts`), registers one route per
 * command name (`routes/commands.ts`), and publishes them to Slack via
 * `generate-manifest.ts`. `~/repos/bags/vantage-slack` ships /oncall and
 * /sentry this way. Nothing in THIS repo reads `slashCommands` — the consumer
 * is a bag, which is why a monorepo-only grep makes it look unused.
 */
export interface BagSlashCommand {
  name: string;
  description: string;
}

/** Slack slash commands entry in a bag manifest (`slash-commands:` in bag.yaml) */
export interface BagSlashCommandsEntry {
  /** Module exporting one handler per declared command name. */
  entry: string;
  commands: BagSlashCommand[];
}

/** A capability requirement declared in a bag manifest (`requires:` in bag.yaml) */
export interface BagRequirement {
  /** Which of the target bag's `services:` this bag calls; omitted = just needs the bag registered */
  resource?: string;
  /** Why — surfaced verbatim in the unmet-requirement error */
  reason?: string;
  /** Unmet: warn and load anyway, instead of dropping the bag's tools */
  optional?: boolean;
  /** A remote `deployment` registry entry satisfies this requirement */
  allowRemote?: boolean;
}

/** Neutral hook event vocabulary — mapped per provider in sdk/src/hooks/hooks.ts */
export type BagHookEvent =
  | "session-start"
  | "session-end"
  | "user-prompt"
  | "stop"
  | "pre-tool"
  | "post-tool";

/** An agent hook declared in a bag manifest (`hooks:` in bag.yaml) */
export interface BagHook {
  event: BagHookEvent;
  /** Script path relative to the bag directory */
  run: string;
  /** Extra argv appended to the command — carries the hook's mode (e.g. session-tracker's `start`) */
  args?: string[];
  /** Claude tool-name matcher (PreToolUse/PostToolUse); omitted = match all */
  matcher?: string;
  /** Cursor matcher (substring semantics, e.g. `"npm "` on beforeShellExecution) */
  cursorMatcher?: string;
  /** Override the default neutral→Cursor event mapping for this hook */
  cursorEvents?: string[];
  /** Per-invocation timeout in seconds */
  timeout?: number;
}

/**
 * Records a bag can hook. Only events, because events have one write path that
 * already announces after commit — see sdk/src/tools/hooks-schema.ts for why errors
 * reach hooks as events rather than directly.
 */
export type BarryHookEvent = "event-created";

/** A hook on a Barry record, declared under `hooks.barry` in bag.yaml. */
export interface BarryHook {
  event: BarryHookEvent;
  /** Script path relative to the bag directory */
  run: string;
  /** Extra argv appended to the command — carries the hook's mode */
  args?: string[];
  /** Per-invocation timeout in seconds */
  timeout?: number;
}

/** A bag hook resolved to a runnable command (absolute script path + runner) */
export interface ResolvedBagHook {
  /** Owning bag, for diagnostics */
  bag: string;
  event: BagHookEvent;
  /** Full command string, e.g. `tsx /abs/path/index.ts start` */
  command: string;
  matcher?: string;
  cursorMatcher?: string;
  cursorEvents?: string[];
  timeout?: number;
}

/**
 * What a bag declares when it wants something RUN.
 *
 * Shared by services, scripts and app builds, which had repeated these three
 * fields over and over. Everything else about them differs — a service carries
 * launchd lifecycle and network identity, a script nothing at all — so only the
 * genuinely common part lives here. (Scheduled work is an action on a
 * schedule, which has its own `run:` shape.)
 *
 * Services normalize literals into named values; scripts retain KEY=VALUE
 * entries. Their representation belongs to each launch consumer.
 *
 * Distinct from the agents' `LaunchPlan` for the same kind of reason: that one
 * carries resolved values, temp dirs to clean up, and a reserved session id,
 * none of which exist in a manifest.
 */
export interface BagLaunch {
  /** Bag-relative entry; command is the normalized interpreter placeholder until launch. */
  entry?: string;
  description: string;
  command: string;
  args?: string[];
  /** Relative to the bag directory; defaults to the bag dir. */
  workingDirectory?: string;
}

export interface BagService extends BagLaunch {
  secrets?: string[];
  /** Secrets the service runs without (`optional-secrets:`). */
  optionalSecrets?: string[];
  /** Authored non-secret process literals. */
  env?: LiteralEnvValue[];
  /**
   * Who starts this: the machine at login (the default), or something else.
   *
   * A service RUNS CONTINUOUSLY by definition, so this is the only part of its
   * lifecycle a bag still chooses. `manual` covers both a service another
   * process bootstraps (coffee's supervisor, started by its own tools) and one
   * that is simply parked until needed (file-stream) — the same case, since
   * neither wants the machine starting it.
   */
  autostart?: "login" | "manual";
  /** Readiness probe path, e.g. "/health". */
  health?: string;
  /**
   * macOS service account this runs as (e.g. "_barryvault"). Absent means the
   * invoking user, installed as a LaunchAgent.
   *
   * Prepare with `barry setup`, then install with `sudo barry setup --system`.
   * The privileged pass creates the account and installs root-owned built code
   * as a LaunchDaemon. Its socket lives under the service's state directory.
   * Ordinary setup and refresh never run it as the invoking user.
   */
  user?: string;
  /**
   * Unix socket path, relative to the state directory for `user:` services
   * and to the bag directory otherwise, instead of an
   * assigned port: kernel-enforced socket permissions are the point, so a TCP
   * listener alongside would reopen what the socket closes.
   */
  socket?: string;
  /**
   * The protocol this service speaks. `http`: it listens on the loopback port
   * the service management assigns (injected as PORT), or on its `socket`.
   */
  serves?: "http";
  /**
   * Its security assumes callers on this Mac, so no tunnel may route to it.
   * Only a `local` name may.
   */
  localOnly?: boolean;
}

/**
 * What a hosting provider bag can do (`provides:` in bag.yaml), in
 * vendor-neutral words: give services local names, and/or carry tunnel routes
 * at the listed reaches behind the listed gates.
 */
export interface BagHostingCapability {
  local?: Record<string, never>;
  tunnel?: { reach: Array<"private" | "public">; gates: Array<"access"> };
}

/** Package script name or an explicit Xcode build. */
export type BagAppBuild = string | { project: string; scheme: string; configuration: string };

export interface BagAppCapabilities {
  /** Legacy App Protocol v1 capabilities. */
  streaming?: boolean;
  gating?: boolean;
  listener?: boolean;
  attachments?: boolean;
  /** Barry AG-UI extension capabilities. */
  approvalReview?: boolean;
  replay?: boolean;
}

/**
 * A GUI application declared by a bag (`apps:` in bag.yaml).
 *
 * Distinct from a service: an app is built, installed as a bundle, and launched
 * by the user, who may quit it. A service that exits has failed; an app that
 * exits has not.
 */
export interface BagApp {
  name: string;
  output: string;
  id?: string;
  displayName?: string;
  protocolVersion?: number;
  capabilities?: BagAppCapabilities;
  description: string;
  platform: "macos" | "ios";
  build: BagAppBuild;
  /** iOS only: whether this app can be signed and installed onto a device. */
  device?: boolean;
  bundleId?: string;
  urlSchemes?: string[];
  loginItem?: boolean;
  keepAlive?: boolean;
}

/**
 * Infrastructure-as-code a bag owns (`infra:` in bag.yaml).
 * Today only Terraform is supported. `barry bag infra <name> plan|apply`
 * runs terraform in the declared root with the declared variables set.
 */
export interface BagInfra {
  provider: "terraform";
  /** Bag-relative path to the terraform root directory */
  root: string;
  /** Env var names terraform needs — validated by doctor, set by `barry bag infra` */
  variables?: string[];
}
/**
 * A command a bag ships, run on demand as `barry <bag> <script>`
 * (`scripts:` in bag.yaml). Nothing installs it, so it carries no launchd
 * bookkeeping; to run one on a timer, make it a `run:` action on a schedule.
 */
export interface BagScript extends BagLaunch {
  secrets?: string[];
  /** Non-secret `KEY=VALUE` literals. Credentials belong under secrets. */
  env?: string[];
}

/**
 * A bag's fallback notifier — see `default_notifier` on the manifest.
 */
export interface BagDefaultNotifier {
  /** Tool to call. Must be provided by this bag and usable without a target. */
  tool: string;
  /**
   * Optional destination. Usually omitted: a default notifier that needs a
   * target is not usable until someone configures it, which defeats the point.
   */
  target?: string;
}

/** Parsed bag.yaml manifest */
/**
 * One harness credential's default source. Vault-only — see
 * `BagManifest.credentials`.
 */
export interface BagCredentialDeclaration {
  source: "vault";
  item: string;
  field: "username" | "password" | "notes" | "uri";
}

export interface BagManifest {
  stores?: Record<string, { owned_by: "identity" | "node"; engine: "sqlite"; migrations: string }>;
  storeSnapshots?: Record<string, { entry: string }>;
  storeRestores?: Record<string, { entry: string }>;
  /** The bag's own release (e.g. "v0.1"), if it declares one. */
  version?: string;
  name: string;
  description: string;
  /**
   * Guidance injected into the session's system prompt when this bag's tools
   * are active. Use it to steer the agent toward the bag's structured tools —
   * e.g. the git bag tells the agent to use git_* tools, not shell git.
   */
  instructions?: string;
  /**
   * A notifier this bag offers when the barry has not configured one.
   *
   * Progress notifications resolve in precedence order: an explicit
   * `notify_tool` argument, then the barry's own `status_notify`, then a
   * bag default, then nothing. The last two exist for different reasons —
   * the barry's setting is a user's deliberate choice and always wins, while
   * this is a bag saying "if you have not picked anything, I can carry it."
   *
   * The tool named here must be one this bag actually provides, and must
   * work without a `target` — a default that needs configuring is not a
   * default.
   */
  default_notifier?: BagDefaultNotifier;
  mcpServers: Record<string, BagMcpServer>;
  /**
   * Credentials a HARNESS bag's sessions authenticate with, as a resolution
   * plan: env var name -> where the value comes from when the identity does
   * not define the variable itself. The identity's own definition wins; this
   * map is the default. Declared here because a claim a picker or the gate
   * can read without loading adapter code is the one that holds.
   *
   * Vault-only: a manifest is shared code, and an inline constant in shared
   * code is either a placeholder (vendor rows have `placeholder` for that) or
   * a secret committed to the repo.
   */
  credentials?: Record<string, BagCredentialDeclaration>;
  tools: BagToolMeta[];
  toolsEntry?: BagToolsEntry;
  toolVisibility?: Record<string, "enabled" | "deferred" | "disabled">;
  promptsEntry?: BagPromptsEntry;
  dependencies: BagDependency[];
  /** macOS privacy permissions its code needs. */
  permissions?: BagPermission[];
  auth?: BagAuthCommand;
  /** CLI exposure configuration — how this bag's tools appear as `barry <group> <tool>` commands */
  cli?: BagCliConfig;
  /** Slash commands this bag provides for the Slack server */
  slashCommands?: BagSlashCommandsEntry;
  /** Agent hooks this bag declares (`hooks.agent`, or the legacy bare array) */
  hooks?: BagHook[];
  /** Record hooks this bag declares (`hooks.barry`) */
  barryHooks?: BarryHook[];
  /** Capabilities of other bags this bag calls (`requires:` in bag.yaml) */
  requires?: Record<string, BagRequirement>;
  /** Long-running services this bag declares (launchd-managed) */
  services: Record<string, BagService>;
  /** GUI applications this bag ships */
  apps: Record<string, BagApp>;
  /** Actions this bag runs on a trigger (`schedules:`), run by the scheduler service */
  schedules: Record<string, BagSchedule>;
  /** Work this bag ships for Barry to run (`jobs:`). Absent when it declares none. */
  jobs?: Record<string, BagJob>;
  /** On-demand commands this bag ships (`barry <bag> <script>`) */
  scripts: Record<string, BagScript>;
  /** Infrastructure-as-code this bag owns (terraform root + variables) */
  infra?: BagInfra;
  /** Hosting this bag can provide (`provides:`), if it is a hosting provider */
  provides?: BagHostingCapability;
  /** Pluggable tool implementations (`implements:` in bag.yaml) that replace tools on required bags. */
  implements?: {
    tools: string[];
  };
  /** Sub-bags this bag includes — auto-enabled when this bag is enabled */
  bags?: string[];
  /** Sub-bags marked `optional: true` — installed/registered with this bag, but not auto-enabled unless explicitly selected */
  optionalBags?: string[];
  /**
   * Where sub-bags named in `bags` come from, for those that say.
   */
  bagSources?: Record<string, BagChildSource>;
  /**
   * Named bounds this bag defines, keyed by name (`bounds:` at the manifest's
   * top level).
   */
  bounds?: Record<string, BagBoundDefinition>;
  constants?: Record<string, unknown>;
  vendors?: import("../adapters/models/vendors/index.js").Vendor[];
}

/** A named bound as a manifest defines it. */
export interface BagBoundDefinition extends Bound {
  description?: string;
  bound: Bound;
}

/**
 * Where a composed sub-bag's code comes from.
 */
export interface BagChildSource {
  /** Git remote: `owner/name` shorthand, or any URL git can clone. */
  repo?: string;
  /** Exact commit to check out. Reproducible; what a submodule gitlink pins. */
  rev?: string;
  /** Branch or tag to track when `rev` is absent. */
  ref?: string;
  /** Filesystem path, relative to the declaring bag's directory. */
  path?: string;
  /**
   * Directory inside the repo that holds the bag, when the clone root is not
   * the bag itself — one bag in a monorepo of them.
   */
  subdir?: string;
  /** When true, the child bag is registered/installed with the parent but not auto-packed when the parent is packed. */
  optional?: boolean;
}

/** Registry entry for a local bag */
export interface LocalBagSource {
  type: "local";
  path: string;
  /**
   * npm package specifier that owns `path` (e.g. `@acme/my-bag`).
   * Stored so the registry can re-resolve a bag whose absolute path
   * vanished after `pnpm install` reshuffled node_modules.
   */
  npm?: string;
  /**
   * Git remote that `path` was cloned from, when Barry fetched it.
   *
   * Provenance, exactly like `npm` above: the bag is still an ordinary local
   * checkout — same loading and building — and this records where it
   * came from so a vanished path can be re-cloned and `bag doctor` can check
   * the checkout still matches what the manifest declared.
   *
   * `rev` is the pinned commit when one was requested; `ref` the branch or tag
   * otherwise. Both are recorded as resolved, not as written, so drift from
   * the manifest is detectable.
   */
  git?: { repo: string; rev?: string; ref?: string };
  /** @deprecated use `access: "disabled"` — kept for back-compat */
  disabled?: boolean;
  access?: BagAccessLevel;
}

/** Registry entry for a remote bag (MCP server or command) */
export interface RemoteBagSource {
  type: "remote";
  url?: string;
  command?: string;
  args?: string[];
  env?: string[];
  /**
   * Connect per session instead of once at startup. Mirrors the manifest's
   * `session-scoped` key (BagMcpServer.sessionScoped) for registry entries,
   * which have no manifest to declare it in. Without this a credentialless
   * remote bag is connected eagerly and its process lives as long as the
   * MCP server, whether or not any session uses it.
   */
  "session-scoped"?: boolean;
  /** @deprecated use `access: "disabled"` — kept for back-compat */
  disabled?: boolean;
  access?: BagAccessLevel;
  /** When true, connect to MCP server and discover barry:// resources */
  resources?: boolean;
  /** Inline tool metadata for bound-based access control */
  tools?: BagToolMeta[];
}

export type BagSource = LocalBagSource | RemoteBagSource;

/**
 * Resolve a bag's effective access level, honoring the legacy `disabled`
 * boolean for back-compat. An explicit `access` field wins.
 */
export function resolveBagAccess(source: BagSource): BagAccessLevel {
  if (source.access !== undefined) return source.access;
  return source.disabled ? "disabled" : "enabled";
}

/** The bag registry: every installed bag by name (config.db, as its snapshot projects it) */
export type BagRegistry = Record<string, BagSource>;

/** A fully loaded bag with resolved paths and capabilities */
export interface Bag {
  name: string;
  description: string;
  builtin: boolean;
  source: BagSource;
  manifest: BagManifest | null;
  skillsDirs: string[];
  /** Dirs holding this bag's actions (`<bagDir>/actions`). Twin of skillsDirs. */
  actionsDirs: string[];
  /** Dirs holding this bag's instructions (`<bagDir>/instructions`). */
  instructionsDirs: string[];
  bounds?: Record<string, BagBoundDefinition>;
  mcpServers: Record<string, BagMcpServer>;
  tools: BagToolMeta[];
  dependencies: BagDependency[];
  slashCommands: BagSlashCommand[];
  /** Agent hooks declared by this bag, resolved to runnable commands */
  hooks: ResolvedBagHook[];
  /** Capability requirements, tagged with the required bag's name */
  requires: Array<BagRequirement & { target: string }>;
  /** Long-running services declared by this bag */
  services: Array<BagService & { name: string }>;
  /** GUI applications declared by this bag */
  apps: Array<BagApp & { name: string }>;
  /** Schedules declared by this bag. `dir` is the bag directory inline actions run in. */
  schedules: Array<BagSchedule & { name: string; dir: string }>;
  /** Jobs declared by this bag. `dir` is the bag directory their paths resolve in. */
  jobs?: Array<BagJob & { name: string; dir: string }>;
  /** Infrastructure declared by this bag */
  infra?: BagInfra;
  /**
   * Why this bag's tool code could not be built or imported, when it could not.
   *
   * Set instead of throwing, so one broken bag degrades itself rather than
   * every load it is part of. Everything the manifest declares (services,
   * schedules, skills, composition) is still present; only `tools` is unknown.
   */
  toolsError?: string;
}

/** Immutable view of one registry resolution, shared by runtime consumers. */
export interface BagRegistrySnapshot {
  registry: Readonly<BagRegistry>;
  bags: readonly Bag[];
  byName: ReadonlyMap<string, Bag>;
}
