export { extensionName, parentOf, registeredName } from "./extensions.js";
import { SecretNamesSchema } from "../env/secret-names.js";
/**
 * Parse and validate bag.yaml manifests
 */

import { DependenciesSchema, normalizeDependencies } from "./dependency-manifest.js";
import { ToolVisibilitySchema } from "../tools/visibility.js";
import { readFileSync, existsSync, statSync } from "fs";
import { join, isAbsolute, normalize, sep } from "path";
import { homedir } from "os";
import { parse } from "yaml";
import { z } from "zod";
import { qualifyPolicyNames } from "./policy-names.js";
import { JobsSchema, normalizeJob, type BagJob } from "./job-manifest.js";
import { resolveConstants } from "./constants.js";
import { VendorCatalogSchema, validateVendorCatalog } from "../adapters/models/vendors/catalog.js";
import { getBagSource } from "./registry.js";
import { BoundSchema } from "../bounds/index.js";
import { HooksSchema, normalizeHooks } from "../tools/hooks-schema.js";
import { LaunchShape, hasOneLaunch, normalizeLaunch } from "../services/launch.js";
import { LiteralEnvSchema, normalizeLiteralEnv } from "../services/literal-env.js";
import { ScheduleSchema, normalizeSchedule, type BagSchedule } from "../schedules/schedule-manifest.js";
import type { BagManifest, BagToolMeta, BagToolsEntry, BagMcpServer, BagAccess, BagChildSource, BagDependency, BagAuthCommand, BagService, BagApp, BagScript } from "./types.js";

const MANIFEST_FILENAME = "bag.yaml";

function resolvePath(p: string): string {
  return p.replace(/^~/, homedir());
}

export function findManifest(bagDir: string): string | null {
  const resolved = resolvePath(bagDir);
  const manifestPath = join(resolved, MANIFEST_FILENAME);
  return existsSync(manifestPath) ? manifestPath : null;
}

/**
 * Validate an already-parsed manifest object.
 *
 * Split out from parseManifest so a manifest arriving over MCP (from a remote
 * bag) gets strict schema validation. Local tools come from code; only an
 * explicitly remote source may carry protocol tool metadata arrays.
 * `label` only shapes the error message.
 */
/**
 * `bagDir` is where inline schedule actions resolve their relative paths.
 * Omitted for a manifest with no directory, where an inline
 * action naming a file cannot resolve and fails as a missing file.
 */
export function parseManifestObject(raw: unknown, label = "manifest", bagDir = "", options: { source?: "local" | "remote" } = {}): BagManifest {
  // Report ownership even when a forbidden declaration has an invalid shape.
  if (raw && typeof raw === "object" && "extends" in raw && raw.extends !== undefined) {
    const forbidden = Object.keys(raw).filter((key) => !EXTENSION_KEYS.has(key));
    if (forbidden.length) throw new Error(`${label}: ${forbidden.map((key) => `${key} is not allowed on an extension; declare it on the parent`).join("; ")}`);
  }
  const providers = new Map<string, { raw: unknown; directory: string }>();
  if (raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).name === "string") {
    providers.set((raw as { name: string }).name, { raw, directory: bagDir });
  }
  raw = resolveConstants(raw, (name, owner) => {
    const provider = providers.get(owner);
    const declarations = provider?.raw && typeof provider.raw === "object" ? (provider.raw as Record<string, unknown>).bags : undefined;
    const child = declarations && !Array.isArray(declarations) && typeof declarations === "object"
      ? (declarations as Record<string, unknown>)[name] : undefined;
    const childPath = child && typeof child === "object" ? (child as Record<string, unknown>).path : undefined;
    const source = provider?.directory && typeof childPath === "string" ? undefined : getBagSource(name);
    const providerPath = provider?.directory && typeof childPath === "string" ? join(provider.directory, childPath) : source?.type === "local" ? source.path : undefined;
    if (!providerPath) throw new Error(`${label}: constant provider ${name} needs an installed local bag or a declared local path`);
    const file = findManifest(providerPath);
    if (!file) throw new Error(`${label}: constant provider ${name} has no manifest`);
    const loaded: unknown = parse(readFileSync(file, "utf8"));
    providers.set(name, { raw: loaded, directory: providerPath });
    return loaded;
  });
  if (raw && typeof raw === "object") {
    const tools = (raw as Record<string, unknown>).tools;
    if (tools && !Array.isArray(tools) && typeof tools === "object") throw new Error(`${label}: tools.entry objects are gone; use tools.ts or src/tools.ts, Barry.Tool metadata, named visibility overrides, and package.json barry.build.externals`);
  }
  const result = ManifestSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.length ? issue.path.join(".") : "manifest"}: ${issue.message}`)
      .join("; ");
    throw new Error(`${label}: ${details}`);
  }

  if (options.source !== "remote" && Array.isArray(result.data.tools) && result.data.tools.length) {
    throw new Error(`${label}: local tool metadata belongs in Barry.Tool code; tools only accepts named visibility overrides`);
  }
  return qualifyPolicyNames(normalizeManifest(result.data, bagDir, label));
}

/**
 * Non-throwing variant for untrusted input.
 *
 * Remote manifests must not be able to break discovery: a third-party server
 * running a newer (or simply wrong) manifest shape should degrade to "no
 * manifest" with a reportable reason, not abort the whole bag load.
 */
export function parseManifestObjectSafe(
  raw: unknown,
  label = "manifest",
  options: { source?: "local" | "remote" } = {},
): { manifest: BagManifest | null; error: string | null } {
  try {
    return { manifest: parseManifestObject(raw, label, "", options), error: null };
  } catch (error) {
    return { manifest: null, error: error instanceof Error ? error.message : String(error) };
  }
}

interface ManifestCacheEntry {
  mtimeMs: number;
  size: number;
  manifest: BagManifest;
}

const manifestCache = new Map<string, ManifestCacheEntry>();

export function clearManifestCache(): void {
  manifestCache.clear();
}

export function parseManifest(bagDir: string): BagManifest | null {
  const manifestPath = findManifest(bagDir);
  if (!manifestPath) return null;

  try {
    const st = statSync(manifestPath);
    const cached = manifestCache.get(manifestPath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.manifest;
    }

    let raw: unknown;
    try {
      raw = parse(readFileSync(manifestPath, "utf-8"));
    } catch (error) {
      throw new Error(`${manifestPath}: invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
    }

    const manifest = parseManifestObject(raw, manifestPath, bagDir);
    manifestCache.set(manifestPath, {
      mtimeMs: st.mtimeMs,
      size: st.size,
      manifest,
    });
    return manifest;
  } catch (error) {
    if (error instanceof Error && error.message.includes("invalid YAML")) {
      throw error;
    }
    // Fall back to reading directly if stat fails
    let raw: unknown;
    try {
      raw = parse(readFileSync(manifestPath, "utf-8"));
    } catch (inner) {
      throw new Error(`${manifestPath}: invalid YAML: ${inner instanceof Error ? inner.message : String(inner)}`);
    }
    return parseManifestObject(raw, manifestPath, bagDir);
  }
}

/**
 * The raw manifest object as written on disk, before normalization.
 *
 * Used when serving a bag over MCP: the wire format is the author's
 * bag.yaml as JSON, so it round-trips through the same strict schema on
 * the other side. Re-emitting the *normalized* form would not, because
 * normalization renames keys (`mcp-servers` -> `mcpServers`).
 */
export function readRawManifest(bagDir: string): Record<string, unknown> | null {
  const manifestPath = findManifest(bagDir);
  if (!manifestPath) return null;
  try {
    const raw = parse(readFileSync(manifestPath, "utf-8"));
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const StringListSchema = z.array(z.string().min(1));
const McpServerSchema = z.object({
  type: z.literal("http").optional(),
  url: z.string().url().optional(),
  command: z.string().min(1).optional(),
  args: StringListSchema.optional(),
  env: StringListSchema.optional(),
  // Declare that this server holds state across calls (a live browser, a
  // running app) so every session gets its own connection instead of sharing
  // the process-wide one. See BagMcpServer.sessionScoped.
  "session-scoped": z.boolean().optional(),
}).strict().refine((server) => Boolean(server.url || server.command), {
  message: "must declare url or command",
});
/**
 * A named bound a manifest defines at its top level. Strict for the same reason
 * as TraitSchema: a misspelled key would otherwise parse clean and restrict
 * nothing. Identity files define bounds with the same fields.
 */
export const BoundDefinitionSchema = z.object({
  description: z.string().min(1),
  bound: BoundSchema,
}).strict();
/**
 * Unknown keys are rejected, like every sibling schema here. Until now this one
 * alone was permissive despite comments claiming otherwise, so a trait that
 * misspelled a restriction key — `bound` for `bounds`, or the reverse — parsed
 * clean and silently unrestricted.
 */
export const TraitSchema = z.object({
  description: z.string(),
  access: z.enum(["read", "readwrite", "write"]).optional(),
  includes: StringListSchema.optional(),
  harnessTraits: z.record(z.string(), z.string().min(1)).optional(),
  nativeTools: z.record(z.string().min(1), z.array(z.string().min(1))).optional(),
  /** Bag/namespace names — accepts both `bags` and legacy `namespaces`. */
  bags: StringListSchema.optional(),
  namespaces: StringListSchema.optional(),
  skills: StringListSchema.optional(),
  /**
   * Instruction names this trait points at. Names, not prose — the body lives
   * in an `instructions/` file and resolves through the instruction catalog,
   * so the text is authored once and stays under the prompt budgets.
   */
  instructions: StringListSchema.optional(),
  /**
   * Named bounds whose restrictions this trait carries. Read-only is composed
   * this way — the grant plus `bounds: [readonly]` — which is exactly what the
   * generated `<bag>:read` twin is. A manifest trait named `read` replaces
   * that twin, for a bag whose read-only variant needs to differ.
   *
   * The legacy `scopes:` spelling was dropped here. It was documented as
   * permanent on the premise that external bag.yaml files are unreachable and
   * unsweepable, so no moment could exist when every bag was known converted.
   * The premise was wrong: every bag.yaml on disk was swept and exactly one
   * still said `scopes:` (the slack bag, since converted). The sweep is also
   * repeatable — registered-manifests.test.ts parses every registered local
   * bag, so a straggler fails the suite instead of failing silently in a
   * running MCP server. `config/*.yaml` keeps its legacy readers, because its
   * gitignored `*.local.yaml` twins genuinely cannot be swept.
   */
  bounds: StringListSchema.optional(),
  /**
   * Restriction declared inline, rather than referenced by name, so an
   * external bag can ship an opinionated bound without a row in this
   * framework's config.
   *
   * Validated against the real bound shape — a permissive `z.record()` would
   * let a misspelled `denyPrograms` parse into a bound that denies nothing and
   * looks, from every angle, exactly like a working one. A restriction that
   * fails open is worse than one that fails to parse.
   */
  bound: BoundSchema.optional(),
}).strict();
const ToolMetaSchema = z.object({
  toolName: z.string().min(1),
  namespace: z.string().min(1),
  access: z.enum(["read", "readwrite", "write"]).optional(),
  includes: StringListSchema.optional(),
  harnessTraits: z.record(z.string(), z.string().min(1)).optional(),
}).strict();
const PromptsEntrySchema = z.object({ entry: z.string().min(1) }).strict();
/**
 * A capability requirement on another bag. Distinct from `dependencies:`
 * (host binaries) and `bags:` (absorb a sub-bag's tools): a requirement
 * gets you a registered bag — and, via `resource`, a URL from the resource
 * registry — never tools. Checked at load by the tool-loading hosts.
 */
const RequirementSchema = z.object({
  resource: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
  optional: z.boolean().optional(),
  "allow-remote": z.boolean().optional(),
}).strict();
const PermissionSchema = z
  .object({
    kind: z.enum(["automation", "accessibility", "screen-recording", "full-disk-access"]),
    app: z.string().min(1).optional(),
    reason: z.string().min(1),
  })
  .strict()
  .refine((p) => p.kind !== "automation" || p.app !== undefined, {
    message: "an `automation` permission names the `app` it sends Apple events to",
  });
const AuthCommandSchema = z.object({
  command: z.string().min(1),
  args: StringListSchema.optional(),
  check: z.object({
    command: z.string().min(1),
    args: StringListSchema.optional(),
  }).strict().optional(),
}).strict();
const CliSchema = z.object({
  alias: z.string().min(1).optional(),
}).strict();
const SlashCommandDefSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
}).strict();
const SlashCommandsSchema = z.object({
  entry: z.string().min(1),
  commands: z.array(SlashCommandDefSchema).min(1),
}).strict();
/**
 * A key the schema no longer accepts, named so its error says what replaced
 * it. Absent is fine; present fails with `message`.
 */
function retired(message: string) {
  return z.unknown().optional().superRefine((value, ctx) => {
    if (value !== undefined) ctx.addIssue({ code: "custom", message });
  });
}

const BagServiceSchema = z.object({
  secrets: SecretNamesSchema.optional(),
  /** Secrets the service runs without: undeclared or absent leaves them unset. */
  "optional-secrets": SecretNamesSchema.optional(),
  description: z.string().min(1),
  ...LaunchShape,
  env: LiteralEnvSchema.optional(),
  "working-directory": z.string().optional(),
  // Services run continuously; login one-shots belong in schedules.
  // Rationale: docs/decisions/0032-sdk-contract-regression-history.md.
  autostart: z.enum(["login", "manual"]).optional(),
  // Retired keys, kept only to say what replaced them: the schema is strict,
  // and "unrecognized key" would leave an author guessing, while an invalid
  // manifest otherwise loads as a silent husk.
  "run-at-load": retired("`run-at-load` was replaced by `autostart`: `run-at-load: false` is `autostart: manual`; true is the default."),
  "keep-alive": retired("`keep-alive` is gone: a service that exits has failed and is always restarted. A one-shot belongs in `schedules:` with `at: login`."),
  port: retired("`port` was replaced by `serves: http`: the service management assigns the port and passes it as PORT."),
  tunnel: retired("`tunnel` is gone: what is exposed where is installation policy, in ~/.config/barry/hosting.yaml. A service whose security assumes local callers declares `local-only: true`."),
  tailnet: retired("`tailnet` is gone: what is exposed where is installation policy, in ~/.config/barry/hosting.yaml."),
  host: retired("`host` is gone: local names are installation policy, in hosting.yaml's `local:` section."),
  health: z.string().min(1).optional(),
  // The account this service runs as. Absent — the overwhelming default — means
  // the invoking user, installed as a LaunchAgent like every other bag service.
  //
  // Naming it makes the service a different PRINCIPAL, which is the only thing
  // on macOS that actually separates it from the agent sessions sharing this
  // machine: same-UID is same-trust, so a secret a service holds is readable by
  // any process the user runs (`docker inspect`, the /usr/bin/security ACL
  // deputy, reading its 0600 plist, attaching to it). A distinct UID is what
  // makes those fail. `bags/vault` is the reason this exists.
  //
  // `barry setup` prepares the declaration; `sudo barry setup --system` creates
  // the account and installs root-owned built JavaScript as a LaunchDaemon.
  // Its socket is relative to the service's state directory, outside the checkout.
  // Ordinary setup and refresh never start a copy as the invoking user.
  //
  // Constrained to the leading-underscore convention every macOS service
  // account uses (_www, _mysql, _spotlight) so a typo cannot silently name a
  // real login account.
  user: z.string().min(1).regex(
    /^_[a-z0-9][a-z0-9_-]*$/,
    "must be a macOS service account name starting with an underscore (e.g. _barryvault)",
  ).optional(),
  // Unix socket this service listens on, relative to its state directory for
  // `user:` services and to its bag directory otherwise. The alternative to
  // `port` for a service that must not be reachable over TCP at all: socket
  // permissions are enforced by the kernel at connect(), so a 0660 socket owned
  // by the service's own group is a real gate rather than an advisory one.
  socket: z.string().min(1).optional(),
  // What this service speaks. `http` means it listens where the service management
  // tells it: a loopback port assigned once and injected as PORT, or its
  // `socket:` when it declares one. The manifest names the protocol and never
  // the number, because the number is a fact about the machine it runs on.
  // A service that serves nothing omits the field.
  serves: z.enum(["http"]).optional(),
  // This service's security assumes its callers are on this Mac: the gateway,
  // for one, attaches the instance secret to whatever reaches it. A fact about
  // the software, so it lives here; core refuses any tunnel route to it.
  "local-only": z.literal(true).optional(),
}).strict().refine(hasOneLaunch, { message: "choose exactly one launch form: entry or command" }).refine((s) => !s.health || s.serves !== undefined || s.socket !== undefined, {
  // A readiness path needs something to request it from.
  message: "`health` requires `serves: http`: there is nothing to probe",
  path: ["health"],
}).refine((s) => !s["local-only"] || s.serves !== undefined || s.socket !== undefined, {
  message: "`local-only` describes a service that serves something: add `serves: http`",
  path: ["local-only"],
});
const AppPathSchema = z.string().min(1).refine(value => {
  const normalized = normalize(value);
  return !isAbsolute(value) && !value.includes("\0") && normalized !== ".." && !normalized.startsWith(`..${sep}`);
}, "must be a path inside the bag");
const BagAppBuildSchema = z.union([
  z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/),
  z.object({ project: AppPathSchema.refine(value => value.endsWith(".xcodeproj"), "must name an Xcode project"),
    scheme: z.string().min(1), configuration: z.string().min(1).default("Release"),
  }).strict(),
]);
const MacosAppSchema = z.object({
  "bundle-id": z.string().min(1).optional(), "url-schemes": StringListSchema.optional(),
  "login-item": z.boolean().optional(), "keep-alive": z.boolean().optional(),
}).strict();
const IosAppSchema = z.object({ "bundle-id": z.string().min(1).optional(),
  "url-schemes": StringListSchema.optional(), device: z.boolean().optional(),
}).strict();
const BagAppCapabilitiesSchema = z.object({
  /** Legacy App Protocol v1 capabilities. */
  streaming: z.boolean().optional(),
  gating: z.boolean().optional(),
  listener: z.boolean().optional(),
  attachments: z.boolean().optional(),
  /** Barry AG-UI extension capabilities. */
  approvalReview: z.boolean().optional(),
  replay: z.boolean().optional(),
}).strict();

const BagAppSchema = z.object({
  id: z.string().min(1).optional(),
  "protocol-version": z.number().int().positive().optional(),
  capabilities: BagAppCapabilitiesSchema.optional(),
  description: z.string().min(1),
  name: z.string().min(1),
  platform: z.enum(["macos", "ios"]),
  build: BagAppBuildSchema,
  output: AppPathSchema.refine(value => value.endsWith(".app"), "output must name an app bundle"),
  macos: MacosAppSchema.optional(),
  ios: IosAppSchema.optional(),
}).strict().refine(
  a => a.platform === "macos" ? a.ios === undefined : a.macos === undefined,
  { message: "platform registration fields must match the app platform" },
).refine(
  (a) => !a.capabilities || a["protocol-version"] !== undefined,
  {
    message: "an app declaring `capabilities` must also declare `protocol-version`",
    path: ["protocol-version"],
  },
).refine(
  (a) => a["protocol-version"] === undefined || a["protocol-version"] === 1 || a["protocol-version"] === 2,
  {
    message: "supported app protocol versions are 1 (legacy) and 2 (AG-UI)",
    path: ["protocol-version"],
  },
);
/**
 * A command the bag ships, run on demand as `barry <bag> <script>`.
 *
 * The same {command, args, working-directory} shape a `run:` action takes, so
 * a script that later wants to run on a timer moves into a schedule's inline
 * action rather than being rewritten. What a script does NOT get is launchd
 * bookkeeping — nothing installs it, so adding one cannot break a deploy.
 *
 * Scripts are resolved from the YAML manifest alone (CLI phase 1), so invoking
 * one never imports the bag's tools module. That is the whole reason a script is
 * not just a tool: a scaffolding command should not pay for a bag's tool
 * dependencies, and must keep working when those imports are broken.
 */
const BagScriptSchema = z.object({
  secrets: SecretNamesSchema.optional(),
  description: z.string().min(1),
  ...LaunchShape,
  env: LiteralEnvSchema.optional(),
  /**
   * Relative to the bag directory. Defaults to the bag dir itself, which is
   * what makes `args: [scripts/foo.ts]` resolve without every script having to
   * reconstruct its own location.
   */
  "working-directory": z.string().optional(),
}).strict().refine(hasOneLaunch, { message: "choose exactly one launch form: entry or command" });
/**
 * Infrastructure-as-code the bag owns — a terraform root directory plus the
 * env vars it needs. Only `terraform` today; declared rather than assumed so
 * a second provider (e.g. pulumi) is a new enum value, not a new field.
 */
const BagInfraSchema = z.object({
  provider: z.literal("terraform"),
  root: z.string().min(1),
  variables: StringListSchema.optional(),
}).strict();

/**
 * A bag's fallback notifier. `target` is deliberately optional and normally
 * omitted — a default that must be configured before it works is not a default.
 */
const DefaultNotifierSchema = z.object({
  tool: z.string().min(1),
  target: z.string().min(1).optional(),
});

/**
 * Where one composed sub-bag comes from.
 *
 * `repo` and `path` are mutually exclusive and one is required. An entry with
 * neither would name no source at all and fall back to "resolve from the
 * registry" — indistinguishable from a bare name, which is exactly the silent
 * behaviour this key exists to replace. `rev`/`ref` only mean anything with a
 * repo, so pairing them with `path` is rejected rather than ignored. `subdir`
 * is the same story: it names a directory inside a clone, so without a `repo`
 * there is nothing for it to be inside of.
 */
const BagChildSourceSchema = z.object({
  repo: z.string().min(1).optional(),
  rev: z.string().min(1).optional(),
  ref: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  subdir: z.string().min(1).optional(),
}).strict().superRefine((v, ctx) => {
  if (!v.repo && !v.path) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "needs `repo` or `path`" });
  }
  if (v.repo && v.path) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "`repo` and `path` are mutually exclusive" });
  }
  if (v.rev && v.ref) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "`rev` and `ref` are mutually exclusive" });
  }
  if (v.path && (v.rev || v.ref)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "`rev`/`ref` need a `repo`" });
  }
  if (v.subdir && !v.repo) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "`subdir` needs a `repo`" });
  }
});

/**
 * `bags:` in either form.
 *
 * The list form (`bags: [git, filesystem]`) composes bags that are already
 * registered, and is unchanged. The map form additionally says where each child
 * comes from, so `barry install` on the parent can fetch it — replacing the git
 * submodules that previously did that job outside Barry's view.
 *
 * Both normalize to the same `bags: string[]` composition list, so every
 * consumer of composition (auto-traits, identity sync, doctor) keeps working
 * without knowing which form was written. Only install reads the sources.
 *
 * Deliberately NOT spelled `packs:`. That is the retired spelling of this very
 * key (packs -> blocks -> bags) and is still read as a string array elsewhere;
 * reusing the word for a differently-shaped value would give one name two
 * meanings depending on the file it appears in.
 */
const BagsListSchema = z.array(z.string().min(1));
const BagsMapSchema = z.record(z.string(), BagChildSourceSchema.nullable());

/**
 * Routed on the runtime shape rather than written as `z.union([list, map])`.
 *
 * Under zod 3 a failing union reported the branch's own error -- "Unrecognized
 * key: 'BAD'", naming the offending key. Zod 4 collapses a union failure to a
 * bare "Invalid input", so the author of a malformed manifest would be told
 * only that something is wrong, not what. A list and a map are trivially
 * distinguishable before parsing, so pick the branch first and let its error
 * through intact.
 */
const BagsSchema = z.custom<string[] | Record<string, z.infer<typeof BagChildSourceSchema> | null>>().superRefine((value, ctx) => {
  const branch = Array.isArray(value) ? BagsListSchema : BagsMapSchema;
  const result = branch.safeParse(value);
  if (!result.success) {
    for (const issue of result.error.issues) {
      // Re-raise as a custom issue: v4's addIssue will not take a $ZodIssue
      // straight back. Message and path are what a manifest author reads.
      ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
    }
  }
});

/**
 * What a hosting provider bag can do, in vendor-neutral words.
 *
 * `local`: it can give services readable names reached from this Mac.
 * `tunnel`: it can carry routes in from elsewhere, at the listed reaches, and
 * gate them with the listed gates. Core joins `hosting.yaml` to these
 * declarations and refuses a route a provider cannot honour: an ungated public
 * route, or a gate the provider does not have.
 */
const ProvidesSchema = z.object({
  local: z.object({}).strict().optional(),
  tunnel: z.object({
    reach: z.array(z.enum(["private", "public"])).min(1),
    gates: z.array(z.enum(["access"])).optional(),
  }).strict().optional(),
}).strict().refine((p) => p.local !== undefined || p.tunnel !== undefined, {
  message: "`provides` must name `local`, `tunnel`, or both",
});

const StoreDeclarationSchema = z.preprocess((value, ctx) => {
  if (value && typeof value === "object" && ["scope", "driver", "entry"].some((key) => key in value)) {
    ctx.addIssue({ code: "custom", message: "store declarations require owned_by, engine, and migrations; replace the provider entry with a SQL migration directory" });
    return z.NEVER;
  }
  return value;
}, z.strictObject({ owned_by: z.enum(["identity", "node"]), engine: z.literal("sqlite"), migrations: z.string().min(1) }));

const EXTENSION_KEYS = new Set(["name", "extends", "description", "version", "instructions", "tools", "dependencies", "schedules", "scripts"]);

const ManifestSchema = z.object({
  // The bag's own release, not a schema version — there is only ever one
  // manifest format, so nothing branches on this. Free-form and optional so a
  // bag can version itself (`v0.1`) without every bag having to.
  version: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string(),
  instructions: z.string().optional(),
  default_notifier: DefaultNotifierSchema.optional(),
  // Retired: the verbs/nouns capability map reached zero adoption and was
  // removed. The keys stay accepted-but-ignored because ManifestSchema is
  // strict and remote bag manifests parse through it — dropping them would
  // make a third-party server still sending them fail validation outright and
  // silently lose its instructions and tools. Same treatment `agents:` got.
  verbs: z.unknown().optional(),
  nouns: z.unknown().optional(),
  "mcp-servers": z.record(z.string(), McpServerSchema).optional(),
  constants: z.record(z.string(), z.unknown()).optional(),
  vendors: VendorCatalogSchema.optional(),
  /**
   * Harness credentials: env var -> vault default. See BagManifest.credentials.
   * A vault-only map — a manifest is shared code, and inline constants in
   * shared code are either placeholders or committed secrets.
   */
  credentials: z
    .record(
      z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "credential keys are env var names"),
      z
        .object({
          source: z.literal("vault"),
          item: z.string().min(1),
          field: z.enum(["username", "password", "notes", "uri"]),
        })
        .strict(),
    )
    .optional(),
  store: StoreDeclarationSchema.optional(),
  stores: z.record(z.string().regex(/^[a-z0-9][a-z0-9_-]*$/), StoreDeclarationSchema).optional(),
  snapshots: z.record(z.string().regex(/^[a-z0-9][a-z0-9_-]*$/), z.strictObject({
    entry: z.string().min(1).refine(entry => /\.(?:m?js)$/.test(entry) && !entry.startsWith("/") && entry.split("/").every(part => part !== ".." && /^[a-z0-9._-]+$/i.test(part)), "snapshot entry must be a compiled JavaScript path inside the bag"),
  })).optional(),
  restores: z.record(z.string().regex(/^[a-z0-9][a-z0-9_-]*$/), z.strictObject({
    entry: z.string().min(1).refine(entry => /\.(?:m?js)$/.test(entry) && !entry.startsWith("/") && entry.split("/").every(part => part !== ".." && /^[a-z0-9._-]+$/i.test(part)), "restore entry must be a compiled JavaScript path inside the bag"),
  })).optional(),
  bounds: z.record(z.string(), BoundDefinitionSchema).optional(),
  traits: z.record(z.string(), TraitSchema).optional(),
  tools: z.union([z.array(ToolMetaSchema), ToolVisibilitySchema.transform(toolVisibility => ({ toolVisibility }))]).optional(),
  prompts: PromptsEntrySchema.optional(),
  "tool-metadata": retired("`tool-metadata` is gone; declare local metadata in Barry.Tool code. Remote MCP metadata uses protocol tool arrays."),
  dependencies: DependenciesSchema.optional(),
  permissions: z.array(PermissionSchema).optional(),
  auth: AuthCommandSchema.optional(),
  cli: CliSchema.optional(),
  "slash-commands": SlashCommandsSchema.optional(),
  hooks: HooksSchema.optional(),
  requires: z.record(z.string(), RequirementSchema).optional(),
  services: z.record(z.string(), BagServiceSchema).optional(),
  apps: z.record(z.string(), BagAppSchema).optional(),
  // Work this bag ships for Barry to run (job-manifest.ts). An entry in the
  // shape `jobs:` had before `schedules:` replaced it is refused with the
  // migration message rather than as unrecognized keys.
  jobs: JobsSchema.optional(),
  // Keys are schedule names: they become the `<bag>/<name>` id and an inline
  // action's name, so they are held to the action-name grammar.
  // Checked by a refine rather than a key schema: zod reports a bad record
  // key as a bare "Invalid key", losing the rule the author needs to read.
  schedules: z.record(z.string(), ScheduleSchema).superRefine((schedules, ctx) => {
    for (const key of Object.keys(schedules)) {
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(key)) {
        ctx.addIssue({ code: "custom", path: [key], message: "schedule names must be kebab-case" });
      }
    }
  }).optional(),
  scripts: z.record(z.string(), BagScriptSchema).optional(),
  deployments: retired("`deployments` is gone; declare provider-owned deploy scripts under `scripts` and keep worker configuration in the provider repository."),
  infra: BagInfraSchema.optional(),
  provides: ProvidesSchema.optional(),
  bags: BagsSchema.optional(),
  extends: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i, "extends must be a plain bag name").optional(),
}).strict().superRefine((value, ctx) => {
  if (value.extends !== undefined) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(value.name)) ctx.addIssue({ code: "custom", path: ["name"], message: "an extension name must be a plain bag name" });
    if (value.extends === value.name) ctx.addIssue({ code: "custom", path: ["extends"], message: "an extension cannot extend itself" });
    for (const key of Object.keys(value)) {
      if (!EXTENSION_KEYS.has(key)) ctx.addIssue({ code: "custom", path: [key], message: `${key} is not allowed on an extension; declare it on the parent` });
    }
    if (Array.isArray(value.tools) && value.tools.length) ctx.addIssue({ code: "custom", path: ["tools"], message: "extension tools only accepts visibility overrides; declare metadata on the parent" });
  }
  if (value.store && value.stores) ctx.addIssue({ code: "custom", path: ["stores"], message: "declare either store or stores, never both" });
  const stores = value.store ? { default: value.store } : value.stores ?? {};
  for (const name of Object.keys(value.snapshots ?? {})) {
    if (!Object.hasOwn(stores, name)) ctx.addIssue({ code: "custom", path: ["snapshots", name], message: "snapshot adapter must name a declared store" });
  }
});

function normalizeAccess(value: unknown): BagAccess {
  const s = String(value ?? "read");
  return s === "readwrite" || s === "write" ? "readwrite" : "read";
}

export function normalizeTrait(d: z.infer<typeof TraitSchema>): NonNullable<BagManifest["traits"]>[string] {
  return {
    description: d.description,
    ...(d.includes ? { includes: d.includes } : {}),
    ...(d.harnessTraits ? { harnessTraits: d.harnessTraits } : {}),
    ...(d.nativeTools ? { nativeTools: d.nativeTools } : {}),
    access: normalizeAccess(d.access),
    bags: d.bags ?? d.namespaces ?? [],
    skills: d.skills ?? [],
    instructions: d.instructions ?? [],
    // `bounds:` in YAML, `boundNames` in the resolved shape — the same
    // spelling split the DB layer uses, where `bound` is already taken by
    // the inline restriction object, carried through just below.
    boundNames: d.bounds ?? [],
    ...(d.bound ? { bound: d.bound } : {}),
  };
}

function normalizeManifest(raw: z.infer<typeof ManifestSchema>, bagDir: string, label: string): BagManifest {
  const name = raw.name;
  const description = raw.description;

  const mcpServers: Record<string, BagMcpServer> = {};
  if (raw["mcp-servers"]) {
    for (const [serverName, d] of Object.entries(raw["mcp-servers"])) {
      mcpServers[serverName] = {
        type: d.type,
        url: d.url,
        command: d.command,
        args: d.args,
        env: d.env,
        sessionScoped: d["session-scoped"],
      };
    }
  }


  const traits: BagManifest["traits"] = {};
  if (raw.traits) {
    for (const [traitName, d] of Object.entries(raw.traits)) {
      traits[traitName] = normalizeTrait(d);
    }
  }



  const toolVisibility = raw.tools && !Array.isArray(raw.tools) ? raw.tools.toolVisibility : undefined;
  let toolsEntry: BagToolsEntry | undefined;
  const tools: BagToolMeta[] = Array.isArray(raw.tools) ? raw.tools.map(tool => ({ ...tool, access: normalizeAccess(tool.access) })) : [];

  if (!toolsEntry && bagDir) {
    const entry = ["tools.ts", "src/tools.ts"].find(path => existsSync(join(bagDir, path)));
    if (entry) toolsEntry = { entry };
  }
  if (toolVisibility && Object.keys(toolVisibility).length && !toolsEntry)
    throw new Error(`${name}: tool visibility overrides require tools.ts or src/tools.ts`);

  // Dependencies — host binaries the bag needs at runtime
  const dependencies: BagDependency[] = normalizeDependencies(raw.dependencies, bagDir);

  // Auth — CLI-delegated auth command (vendor CLIs with their own OAuth)
  let auth: BagAuthCommand | undefined;
  if (raw.auth) {
    auth = {
      command: raw.auth.command,
      ...(raw.auth.args ? { args: raw.auth.args } : {}),
      ...(raw.auth.check ? { check: { command: raw.auth.check.command, ...(raw.auth.check.args ? { args: raw.auth.check.args } : {}) } } : {}),
    };
  }

  // Services — long-running launchd-managed processes declared by the bag
  const services: Record<string, BagService> = {};
  if (raw.services) {
    for (const [svcName, s] of Object.entries(raw.services)) {
      services[svcName] = {
        description: s.description,
        ...normalizeLaunch(s),
        env: normalizeLiteralEnv(s.env ?? []),
        secrets: s.secrets,
        ...(s["optional-secrets"]?.length ? { optionalSecrets: s["optional-secrets"] } : {}),
        workingDirectory: s["working-directory"],
        // Resolved to one value here so nothing downstream has to know both
        // spellings exist. The schema refuses the case where they disagree, so
        // this fallback only ever reads a manifest that declared exactly one.
        autostart: s.autostart ?? "login",
        health: s.health,
        user: s.user,
        socket: s.socket,
        // Listed explicitly because this mapper is an allowlist, not a spread:
        // a field the SCHEMA accepts but this omits validates fine and then
        // silently vanishes.
        ...(s.serves ? { serves: s.serves } : {}),
        ...(s["local-only"] ? { localOnly: true } : {}),
      };
    }
  }

  const apps: Record<string, BagApp> = {};
  if (raw.apps) {
    for (const [appName, a] of Object.entries(raw.apps)) {
      apps[appName] = {
        id: a.id,
        displayName: a.name,
        protocolVersion: a["protocol-version"],
        capabilities: a.capabilities,
        description: a.description,
        platform: a.platform,
        name: a.name,
        build: a.build,
        output: a.output,
        device: a.ios?.device,
        bundleId: (a.macos ?? a.ios)?.["bundle-id"],
        urlSchemes: (a.macos ?? a.ios)?.["url-schemes"],
        loginItem: a.macos?.["login-item"],
        keepAlive: a.macos?.["keep-alive"],
      };
    }
  }

  // Schedules — actions run on a trigger by the scheduler service
  const schedules: Record<string, BagSchedule> = {};
  for (const [scheduleName, sched] of Object.entries(raw.schedules ?? {})) {
    schedules[scheduleName] = normalizeSchedule(scheduleName, sched, bagDir, label);
  }

  // Jobs — work Barry runs for a schedule, the SDK, or a subagent
  const jobs: Record<string, BagJob> = {};
  for (const [jobName, job] of Object.entries(raw.jobs ?? {})) {
    jobs[jobName] = normalizeJob(jobName, job, label);
  }

  // Scripts — on-demand commands the bag ships (`barry <bag> <script>`)
  const scripts: Record<string, BagScript> = {};
  if (raw.scripts) {
    for (const [scriptName, s] of Object.entries(raw.scripts)) {
      scripts[scriptName] = {
        description: s.description,
        ...normalizeLaunch(s),
        env: s.env,
        secrets: s.secrets,
        workingDirectory: s["working-directory"],
      };
    }
  }

  const normalizedHooks = normalizeHooks(raw.hooks);


  return {
    ...(raw.version ? { version: raw.version } : {}),
    name,
    description,
    ...(raw.instructions ? { instructions: raw.instructions } : {}),
    ...(raw.default_notifier ? { default_notifier: raw.default_notifier } : {}),
    mcpServers,
    ...(raw.store ? { stores: { default: raw.store } } : raw.stores ? { stores: raw.stores } : {}),
    ...(raw.snapshots ? { storeSnapshots: raw.snapshots } : {}),
    ...(raw.restores ? { storeRestores: raw.restores } : {}),
    ...(raw.bounds ? { bounds: raw.bounds } : {}),
    ...(raw.constants ? { constants: raw.constants } : {}),
    // Compatibility doors can point at a vendor in another installed bag.
    // The assembled registry validates those relationships together.
    ...(raw.vendors ? { vendors: validateVendorCatalog(raw.vendors, false) } : {}),
    ...(raw.credentials ? { credentials: raw.credentials } : {}),
    traits,
    tools,
    toolsEntry,
    ...(toolVisibility ? { toolVisibility } : {}),
    ...(raw.prompts ? { promptsEntry: raw.prompts } : {}),
    dependencies,
    ...(raw.permissions?.length ? { permissions: raw.permissions } : {}),
    ...(auth ? { auth } : {}),
    ...(raw.cli ? { cli: raw.cli } : {}),
    ...(raw["slash-commands"] ? { slashCommands: raw["slash-commands"] } : {}),
    // Both spellings of `hooks:` collapse here, so nothing downstream has to
    // know whether the author wrote the bare array or the map.
    ...(normalizedHooks.agent.length
      ? {
          hooks: normalizedHooks.agent.map((h) => ({
            event: h.event,
            run: h.run,
            ...(h.args ? { args: h.args } : {}),
            ...(h.matcher !== undefined ? { matcher: h.matcher } : {}),
            ...(h["cursor-matcher"] !== undefined ? { cursorMatcher: h["cursor-matcher"] } : {}),
            ...(h["cursor-events"] !== undefined ? { cursorEvents: h["cursor-events"] } : {}),
            ...(h.timeout !== undefined ? { timeout: h.timeout } : {}),
          })),
        }
      : {}),
    ...(normalizedHooks.barry.length
      ? {
          barryHooks: normalizedHooks.barry.map((h) => ({
            event: h.event,
            run: h.run,
            ...(h.args ? { args: h.args } : {}),
            ...(h.timeout !== undefined ? { timeout: h.timeout } : {}),
          })),
        }
      : {}),
    ...(raw.requires && Object.keys(raw.requires).length
      ? {
          requires: Object.fromEntries(
            Object.entries(raw.requires).map(([target, r]) => [target, {
              ...(r.resource !== undefined ? { resource: r.resource } : {}),
              ...(r.reason !== undefined ? { reason: r.reason } : {}),
              ...(r.optional !== undefined ? { optional: r.optional } : {}),
              ...(r["allow-remote"] !== undefined ? { allowRemote: r["allow-remote"] } : {}),
            }]),
          ),
        }
      : {}),
    services,
    apps,
    schedules,
    ...(Object.keys(jobs).length ? { jobs } : {}),
    scripts,
    ...(raw.infra ? { infra: { provider: raw.infra.provider, root: raw.infra.root, ...(raw.infra.variables ? { variables: raw.infra.variables } : {}) } } : {}),
    ...(raw.provides
      ? {
          provides: {
            ...(raw.provides.local ? { local: {} } : {}),
            ...(raw.provides.tunnel
              ? { tunnel: { reach: raw.provides.tunnel.reach, gates: raw.provides.tunnel.gates ?? [] } }
              : {}),
          },
        }
      : {}),
    ...(raw.extends ? { extends: raw.extends } : {}),
    ...normalizeBags(raw.bags),
  };
}

/**
 * Collapse either `bags:` form into the composition list every consumer reads,
 * plus the sources only install cares about.
 *
 * Map order is preserved, so composition order stays what the author wrote. A
 * `null` value is allowed and means "compose this, source unstated" — the YAML
 * `my-bag:` with nothing after it, which parses as null rather than an empty
 * object and would otherwise be a confusing validation error.
 */
function normalizeBags(
  raw: string[] | Record<string, BagChildSource | null> | undefined,
): { bags?: string[]; bagSources?: Record<string, BagChildSource> } {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    return raw.length ? { bags: raw } : {};
  }
  const names = Object.keys(raw);
  if (!names.length) return {};
  const sources: Record<string, BagChildSource> = {};
  for (const [name, source] of Object.entries(raw)) {
    if (source) sources[name] = source;
  }
  return {
    bags: names,
    ...(Object.keys(sources).length ? { bagSources: sources } : {}),
  };
}

export function getSkillsDirs(bagDir: string): string[] {
  const resolved = resolvePath(bagDir);
  const skillsDir = join(resolved, "skills");
  return existsSync(skillsDir) ? [skillsDir] : [];
}
