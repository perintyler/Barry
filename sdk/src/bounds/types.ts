import { z } from "zod";

/**
 * Access level for agent capabilities.
 * - "read": observe without side effects
 * - "readwrite": observe and modify
 */
export type Access = "read" | "readwrite";

/**
 * Agent Trait — a named capability granted to a task.
 * Traits enable: they grant namespaces and/or individual tools with an access level.
 */
export interface AgentTrait {
  name: string;
  /** Tool namespaces this trait enables — all tools in a namespace are granted */
  namespaces: string[];
  /**
   * Individual tools this trait enables — takes precedence over namespace
   * grants. Entries should be qualified `namespace:tool` ids; a bare tool name
   * is legacy, matches that name in EVERY namespace, and emits a deprecation
   * warning at resolution. Prefer `"sentry:search_issues"` over `"search_issues"`.
   */
  tools?: string[];
  /** Access level granted to all namespaces and tools in this trait */
  access: Access;
  /** Composite: includes other traits */
  includes?: string[];
  harnessTraits?: Record<string, string>;
  nativeTools?: Record<string, string[]>;
  /**
   * Restrictions carried by this trait. Merged (union of denials) with any
   * barry/session bound at resolution time. Lets a trait bundle a policy with
   * its grants — e.g. the `coding` trait grants git tools but denies raw
   * git/gh in Bash so all git goes through the structured tools.
   */
  bound?: Bound;
  /** Named bounds whose restrictions this trait carries — resolved and merged at session bound time. */
  boundNames?: string[];
}

/**
 * Agent Bound — restrictions on a task's capabilities.
 * Bounds limit: they can only take away what traits have granted.
 */
export interface Bound {
  name?: string;
  description?: string;
  /** Which installations may run this work: this one ("local" or its id) and the workers it invited. */
  nodes?: { allow?: string[]; deny?: string[] };
  /** Native tools denied by their declaring harness, separate from MCP tools. */
  nativeTools?: Record<string, string[]>;
  /** Tools excluded entirely — by namespace or toolName */
  deniedTools?: string[];
  /** Deny write access globally ("write") or for specific namespaces/tools */
  deniedAccess?: string[];
  /**
   * Filesystem path restrictions.
   *
   * `deny` removes the paths it matches. `allowOnly` is the other direction:
   * when present, every path that matches NONE of its patterns is denied, so
   * the session may touch only what it names (e.g. `~/repos/vantage/**`).
   * Deny is checked first — a path matching both lists is denied.
   *
   * Merging moves toward more restriction: deny lists union, allowOnly lists
   * intersect (the same rule as network.allowDomains). An allowlist also
   * takes back the harness bag’s native file and shell tools because
   * the provider's own Read/Bash never pass through the guards.
   */
  files?: { deny?: string[]; allowOnly?: string[] };
  /** Bash command restrictions */
  bash?: {
    /**
     * Legacy substring deny patterns — a command is denied if it contains any
     * pattern as a substring. Fragile (misses `git -C`, false-positives on
     * `legit`); kept for backward compat. Prefer `denyPrograms`.
     * @deprecated Use denyPrograms for program-aware matching.
     */
    deny?: string[];
    /**
     * Deny by resolved program name. Each entry is a program (`"git"`, `"gh"`)
     * or `program:subcommand` (`"git:push"`). Every command in the line —
     * across `&&`/`||`/`;`/`|`, subshells, and command substitutions, with env
     * prefixes and wrappers (`env`, `sudo`, `xargs`, `sh -c` …) unwrapped — has
     * its argv[0] basename matched against these. Fails closed on unparseable
     * or obfuscated input.
     */
    denyPrograms?: string[];
  };
  /** Network access restrictions */
  network?: {
    /**
     * Network actions to deny. Entries are hierarchical action tags:
     *   "all"        — all network access
     *   "write"      — all outbound writes (git:push, http:write, ssh:write)
     *   "read"       — all outbound reads (git:fetch, http:read, dns)
     *   "git:push"   — git push specifically
     *   "git:fetch"  — git fetch/pull/clone
     *   "http:write" — HTTP POST/PUT/PATCH/DELETE
     *   "http:read"  — HTTP GET/HEAD
     *   "ssh:write"  — scp upload, rsync push
     *   "ssh:read"   — ssh connections
     *   "dns"        — DNS lookups (dig, nslookup, host)
     *
     * Parent tags expand to include their children: "write" implies
     * "git:push" + "http:write" + "ssh:write".
     */
    actions?: string[];
    /**
     * Destination domains to deny. Supports wildcards: "*.internal.co"
     * matches "api.internal.co". Best-effort — inspects URL arguments in
     * bash commands (curl, wget, git clone). Cannot cover bag proxy tools
     * or dynamically constructed URLs.
     */
    domains?: string[];
    /**
     * Destination hosts the session may reach, enforced by the agent runtime's
     * egress proxy. Requires `enforce: "sandbox"`: the app-level guards cannot
     * enforce an allowlist, so a bound that sets this without it is refused.
     *
     * This is the inverse of `domains`, and the two are NOT interchangeable: a
     * deny-list says nothing about which of the infinite remaining hosts are
     * acceptable. Both may be set; they are independent layers and a host
     * present in `domains` is denied regardless of this list.
     *
     * Omitting it under `enforce: "sandbox"` means an EMPTY allowlist — no
     * egress except localhost. Opening a host is always an explicit act.
     */
    allowDomains?: string[];
    /**
     * Enforcement level:
     *   "guard"   (default) — application-level tool/command interception only.
     *                         Cooperative safety rail with clear error messages.
     *   "sandbox" — adds the agent runtime's process-tree sandbox: outbound
     *               traffic is forced through an egress proxy that filters by
     *               HOSTNAME (see `allowDomains`), and the agent cannot lift
     *               it. Covers write-to-disk bypasses and network binaries the
     *               command classifier doesn't know. It filters by host, not
     *               by HTTP method, so partial action denials (e.g.
     *               actions: ["write"]) still rely on the guards.
     */
    enforce?: "guard" | "sandbox";
  };
}

/**
 * Every valid `network.actions` tag. Parents expand to their children —
 * see NETWORK_ACTION_HIERARCHY in network-classifier.ts.
 */
export const NETWORK_ACTIONS = [
  "all",
  "write",
  "read",
  "git:push",
  "git:fetch",
  "http:write",
  "http:read",
  "ssh:write",
  "ssh:read",
  "dns",
] as const;

export type NetworkAction = (typeof NETWORK_ACTIONS)[number];

/**
 * Why a bound naming `network.allowDomains` without `enforce: "sandbox"` is
 * refused: only the egress sandbox can enforce an allowlist, so under the
 * guards it would read as a restriction and restrict nothing.
 */
export const ALLOW_DOMAINS_NEEDS_SANDBOX =
  "network.allowDomains is enforced only by the egress sandbox: add network.enforce: \"sandbox\", or deny hosts with network.domains instead";

/**
 * Strict at every level, for the same reason `network.actions` is an enum
 * rather than a string: a restriction that fails to parse is loud, while one
 * that parses into an empty object denies nothing and is indistinguishable
 * from a working bound. A misspelled `denyProgram` or `deniedTool` must not
 * leave the session quietly unrestricted.
 */
export const BoundSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  nodes: z.strictObject({ allow: z.array(z.string().min(1)).optional(), deny: z.array(z.string().min(1)).optional() }).optional(),
  nativeTools: z.record(z.string().min(1), z.array(z.string().min(1))).optional(),
  deniedTools: z.array(z.string()).optional(),
  deniedAccess: z.array(z.string()).optional(),
  files: z
    .object({ deny: z.array(z.string()).optional(), allowOnly: z.array(z.string().refine(path => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path) || path === "~" || path.startsWith("~/"), "files.allowOnly requires absolute or home-relative paths; relative session roots are ambiguous")).optional() })
    .strict()
    .optional(),
  bash: z
    .object({
      deny: z.array(z.string()).optional(),
      denyPrograms: z.array(z.string()).optional(),
    })
    .strict()
    .optional(),
  network: z
    .object({
      // An enum, not z.string(): unknown tags expand to nothing and enforce
      // nothing, so a typo like ["writes"] would validate cleanly and silently
      // leave the session unrestricted.
      actions: z.array(z.enum(NETWORK_ACTIONS)).optional(),
      domains: z.array(z.string()).optional(),
      allowDomains: z.array(z.string()).optional(),
      enforce: z.enum(["guard", "sandbox"]).optional(),
    })
    .strict()
    .refine((network) => network.allowDomains === undefined || network.enforce === "sandbox", {
      message: ALLOW_DOMAINS_NEEDS_SANDBOX,
      path: ["allowDomains"],
    })
    .optional(),
}).strict();

/**
 * MCP tool annotations — advisory hints about a tool's behavior.
 * Local mirror of the MCP spec's ToolAnnotations to avoid SDK coupling.
 */
export interface McpAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * Metadata for a tool — namespace, name, and whether it reads or writes.
 * This is just metadata, not the tool itself.
 */
export interface ToolMeta {
  namespace: string;
  toolName: string;
  access: "read" | "write";
  /** Trusted catalog evidence for the versioned input/output contract. */
  contractHash?: string;
  /** MCP annotations from the tool's upstream server or definition. */
  annotations?: McpAnnotations;
}

// Named bounds carry their rules at the same level as their name.
const namedBoundSchema = BoundSchema.extend({ name: z.string().min(1) });
export const BoundListResponseSchema = z.strictObject({ bounds: z.array(namedBoundSchema) });
export const CreateBoundRequestSchema = namedBoundSchema;
export const BoundResponseSchema = z.strictObject({ bound: namedBoundSchema });
/** Names stay fixed because identities and traits reference them. */
export const UpdateBoundRequestSchema = BoundSchema.omit({ name: true });
