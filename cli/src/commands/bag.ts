import { loadBagToolDefinitions, loadRegistry, isBuiltinBag, getBagSource, resolveBuiltinPath, checkBagRequirements, packedBagsRequiring, loadBag, loadBagSync, loadAllBags, expandCompositionFromSnapshot, getInvalidManifests, collectDeclaredMcpServers, findServerKeyConflicts, findEndpointDuplicates, checkBagDependencyStates, packageInstallationSummary, bagNeedsInstall, getRegistrySnapshotPath } from "@barry-rocks/sdk/internal/bags";
import { CliError, isCliError } from "../lib/cli-error.js";
import { applyToolVisibility } from "@barry-rocks/sdk/internal/tools";
/**
 * CLI commands for bag management.
 *
 * A bag moves through four stages, each its own command so a failure at one
 * stage cannot masquerade as success at the next:
 *
 *   barry new <name>                 — scaffold a bag skeleton on disk
 *   barry install <path|npm|url>     — SYSTEM: deps, build, register on this machine
 *   <identity> pack <bag>            — add it to that identity's identity.yaml
 *                                      and create its stores
 *   <identity> unpack <bag>          — take it off again (files untouched)
 *
 * `<identity> install <target>` is the system install followed by a y/N offer
 * to pack it onto that identity. Installing and packing stay separate steps
 * so "on this machine" and "on this identity" never blur.
 *
 * `install` deliberately does NOT clone: fetching code is git's job, so the
 * flow is `git clone … && barry install ./thing`. `pack` refuses a bag that is
 * not installed rather than half-wiring it — a registered-but-unbuilt bag
 * contributes zero tools and surfaces much later as "my tools vanished".
 *
 * Inspection and maintenance stay under the `bag` group:
 *
 *   barry bag list | show | access | doctor | build | serve | deploy | infra | auth
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { backupBeforeDoctorWrite, migrateBagManifestObject } from "./doctor-migration.js";
import { createRequire } from "module";
import { createInterface } from "readline";
import { homedir } from "os";
import { join, dirname, resolve, basename } from "path";
import { spawn, spawnSync } from "child_process";
import { restartManagedService, reconcileServices } from "./service.js";
import { instanceEnvValue, bagDataDir, MCP_SERVER_KEY, serviceRegistryPath } from "@barry-rocks/sdk/services";

import { serviceLaunchPath, stableNodePath } from "@barry-rocks/sdk/internal/services";
import { serviceRequest, ServiceManagementError } from "@barry-rocks/mcp-bag";
// Subpath, not the barrel: the barrel pulls in build.ts, whose dynamic esbuild
// import cannot run from a bundle (see action-registry.ts).
import { listAllActions, parseActionFile } from "@barry-rocks/sdk/internal/actions";
import { checkActionJobLinks, checkJobLinks, listAllJobs } from "@barry-rocks/sdk/internal/jobs";
// Narrow subpaths, not the "@barry-rocks/sdk/bags" root: the root barrel re-exports
// all 39 modules, so any one symbol drags in build.ts's dynamic esbuild import
// and the MCP SDK. The dynamic `import("@barry-rocks/sdk/internal/bags")` calls below
// exist to keep esbuild off the hot path — a root import here would defeat them.

import { fetchBagRepo, resolveRepoUrl, headOf, originOf, sameRemote, BagFetchError } from "../bags/git-source.js";
import { scaffoldBag } from "../bags/scaffold.js";
import { scaffoldActionDir, scaffoldBound, scaffoldInstruction } from "../bags/scaffold-kinds.js";
import { summarizeBound } from "../lib/bound-summary.js";
import {
  hasOAuthTokens,
  getOAuthAccessToken,
  refreshOAuthToken,
  isOAuthBag,
  getDeclaredEnvVars,
} from "@barry-rocks/sdk/internal/vault";

import { resolveBagAccess, parseManifest } from "@barry-rocks/sdk/bags";

import type { Bag, BagSource, BagAccessLevel, BagManifest, BagChildSource, BagPermission } from "@barry-rocks/sdk/bags";

import { Barry, isBarryError } from "@barry-rocks/sdk";
import {
  identityRecords,
  owner,
  resolveBags,
  type BagSyncWarning,
} from "@barry-rocks/identities-bag";
import type { ServiceStatus } from "@barry-rocks/mcp-bag";
import { findWeakDescriptions } from "./service-descriptions.js";
import { findSnapshotDrift as findSnapshotDriftBetween, type SnapshotEntry } from "./snapshot-drift.js";
// Registry WRITES go to the config store (authoritative); the snapshot that
// sync readers use is refreshed by these calls.
import { upsertBag, deleteBag, getBag, listBags, writeRegistrySnapshot, snapshotSourceOf } from "../bags/registration.js";
import { getCurrentUser, getActiveIdentity } from "../lib/current-user.js";
import { printWarnings } from "../lib/warnings.js";
import { describeTrigger } from "@barry-rocks/schedules-bag";



/**
 * Paths a skill produces by being run, rather than by being shipped.
 *
 * Matched on any path segment, since the output lands under the skill root
 * (`tmp/k8s.pod.foo.yml`) or deeper (`scripts/tmp/...`). Deliberately a short,
 * closed list: anything broader risks masking a real difference between two
 * copies of a skill, which is the thing the comparison exists to catch.
 */
const GENERATED_DIRS = new Set(["tmp", "node_modules", ".cache", "__pycache__"]);

export function isGeneratedArtifact(relativePath: string): boolean {
  const segments = relativePath.split(/[/\\]/);
  // The basename is a file; only its parent directories can mark it generated.
  return segments.slice(0, -1).some((segment) => GENERATED_DIRS.has(segment));
}




/**
 * Skills that are on disk but cannot be loaded.
 *
 * A skill reaches a session only if the agent can index it, which needs YAML
 * frontmatter with a description — the file existing is not enough. Barry
 * itself never reads the filename (buildSkillsPlugin symlinks whole
 * directories), so casing does not matter and is deliberately not checked.
 *
 * This failure is silent by nature: the directory looks right, `install`
 * reports success, and the skill simply never appears. A batch of them sat
 * unloadable across several bags until someone went looking.
 */
export function findUnloadableSkills(skillsDirs: string[]): Array<{ name: string; reason: string }> {
  const problems: Array<{ name: string; reason: string }> = [];

  for (const dir of skillsDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const skillDir = join(dir, entry);
      if (!statSync(skillDir).isDirectory()) continue;

      // A converted capability keeps its directory and swaps SKILL.md for
      // action.yaml, which the action registry reads in BOTH the actions and skills
      // passes. Checking only for SKILL.md reported every converted skill as
      // unloadable — 110 of them — under a message claiming they never reach a
      // session, which was exactly backwards.
      if (existsSync(join(skillDir, "action.yaml"))) {
        try {
          parseActionFile(skillDir);
        } catch (err) {
          problems.push({
            name: entry,
            reason: `action.yaml does not parse: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
          });
        }
        continue;
      }

      const file = ["SKILL.md", "skill.md"].map((n) => join(skillDir, n)).find((p) => existsSync(p));
      if (!file) {
        problems.push({ name: entry, reason: "no SKILL.md or action.yaml" });
        continue;
      }

      const content = readFileSync(file, "utf-8");
      if (!content.startsWith("---")) {
        problems.push({ name: entry, reason: "no frontmatter" });
      } else if (!/^description:/m.test(content.slice(0, content.indexOf("---", 3)))) {
        problems.push({ name: entry, reason: "frontmatter has no description" });
      }
    }
  }

  return problems;
}

export async function bagListCommand(): Promise<void> {
  const registry = loadRegistry();
  const names = Object.keys(registry);

  if (names.length === 0) {
    console.log("No bags registered. Add one with: barry install <path|npm|url>");
    return;
  }

  const builtinNames = names.filter((n) => isBuiltinBag(n));
  const userNames = names.filter((n) => !isBuiltinBag(n));

  const formatSource = (name: string, source: BagSource) => {
    const access = resolveBagAccess(source);
    const tag = access === "enabled" ? "" : ` (${access})`;
    if (source.type === "local") {
      return `  ${name} — local: ${source.path}${tag}`;
    }
    const target = source.url || source.command || "unknown";
    return `  ${name} — remote: ${target}${tag}`;
  };

  if (builtinNames.length > 0) {
    console.log("Builtin bags:\n");
    for (const name of builtinNames) console.log(formatSource(name, registry[name]));
  }

  if (userNames.length > 0) {
    if (builtinNames.length > 0) console.log("");
    console.log("User bags:\n");
    for (const name of userNames) console.log(formatSource(name, registry[name]));
  }

  try {
    await getCurrentUser();
    const owned = (await identityRecords.list()).map((entry) => entry.record);

    const assignments: string[] = [];
    for (const prof of owned) {
      const bags = prof.metadata.bags ?? [];
      if (bags.length > 0) {
        assignments.push(`  ${prof.name}: ${bags.join(", ")}`);
      }
    }

    if (assignments.length > 0) {
      console.log("\nBarry bag assignments:\n");
      for (const a of assignments) console.log(a);
    }
  } catch {
    // DB might not be available — skip barry info
  }
}

export async function bagShowCommand(name: string): Promise<void> {
  const source = getBagSource(name);
  if (!source) {
    throw new CliError(`Bag "${name}" is not registered. Add it with: barry install <path-or-url> --name ${name}`, 1);
  }

  const access = resolveBagAccess(source);

  // Disabled bags can't be loaded (loadBag returns null), but we can still
  // show what we know from the registry entry alone.
  if (access === "disabled") {
    console.log(`Bag: ${name}`);
    console.log(`Type: ${source.type}`);
    console.log(`Access: disabled`);
    if (source.type === "local") console.log(`Path: ${source.path}`);
    if (source.type === "remote" && source.url) console.log(`URL: ${source.url}`);
    console.log(`\nBag is disabled — set access to "enabled" or "deferred" to see full details.`);
    return;
  }

  const result = loadBag(name);
  const bag = result instanceof Promise ? await result : result;
  if (!bag) {
    throw new CliError(`Bag "${name}" could not be loaded.`, 1);
  }

  console.log(`Bag: ${bag.name}`);
  if (bag.description) console.log(`Description: ${bag.description}`);
  if (bag.manifest?.implements) console.log(`Implements: ${bag.manifest.implements}`);
  console.log(`Type: ${bag.source.type}`);
  console.log(`Access: ${access}`);
  if (bag.source.type === "local") console.log(`Path: ${bag.source.path}`);

  if (Object.keys(bag.mcpServers).length > 0) {
    console.log(`\nMCP servers: ${Object.keys(bag.mcpServers).join(", ")}`);
  }

  // Composition: render what this bag pulls in via `bags:` so the dependency
  // is tooling-visible.
  let showBagsByName: Map<string, Awaited<ReturnType<typeof loadAllBags>>[number]> | undefined;
  if ((bag.manifest?.bags ?? []).length > 0) {
    console.log(`\nComposes bags: ${(bag.manifest?.bags ?? []).join(", ")}`);
  }

  const manifestBounds = bag.manifest?.bounds ?? {};
  const boundEntries = Object.entries(manifestBounds);
  if (boundEntries.length > 0) {
    console.log("\nBounds:");
    for (const [boundName, def] of boundEntries) {
      const summary = summarizeBound(def.bound);
      const detail = def.description ? `${def.description} (${summary})` : summary;
      console.log(`  ${boundName} — ${detail}`);
    }
  }

  if (bag.skillsDirs.length > 0) {
    console.log(`\nSkills dirs: ${bag.skillsDirs.join(", ")}`);

    const unloadable = findUnloadableSkills(bag.skillsDirs);
    for (const { name, reason } of unloadable) {
      console.log(`  ✗ ${name} — ${reason}`);
    }
    if (unloadable.length > 0) {
      console.log("    These sit on disk but never reach a session.");
    }
  }

  if ((bag.jobs ?? []).length > 0 || bag.actionsDirs.length > 0) {
    // Links between jobs and actions resolve across bags, so they are checked
    // against everything installed; a broken one is reported, not fatal.
    const all = showBagsByName ? [...showBagsByName.values()] : await loadAllBags();
    const actions = await listAllActions(all);
    const ownJobs = listAllJobs(all).filter((job) => job.bag === bag.name);
    if (ownJobs.length > 0) {
      console.log("\nJobs:");
      for (const job of ownJobs) console.log(`  ${job.name} (${job.runs.using}${job.version ? ` @${job.version}` : ""})${job.description ? ` — ${job.description}` : ""}`);
    }
    const problems = [
      ...checkJobLinks(ownJobs, actions).map((p) => `job ${p.job} ${p.problem}`),
      ...checkActionJobLinks(actions.filter((a) => a.bag === bag.name), all).map((p) => `action ${p.action} ${p.problem}`),
    ];
    for (const problem of problems) console.log(`  ✗ ${problem}`);
  }

  if (bag.tools.length > 0) {
    console.log(`\nTool metadata: ${bag.tools.length} tools`);
  }

  if (bag.dependencies.length > 0) {
    console.log("\nDependencies:");
    // Resolved against the MCP SERVER's PATH, not this CLI's. The two differ —
    // that gap is what let `bag show` print ✓ for a binary every tool call
    // reported as "not installed".
    const serverPath = serviceLaunchPath();
    for (const status of checkBagDependencyStates(bag, serverPath)) {
      const { dependency: dep, state, resolvedPath } = status;
      const reason = `${dep.optional ? " (optional)" : ""}${dep.reason ? ` (${dep.reason})` : ""}`;

      let line: string;
      switch (state) {
        case "ok":
          line = `✓  ${dep.name}${reason}`;
          break;
        case "unreachable":
          // Installed, so "install it" would be wrong advice. Say where it is
          // and why the server still cannot run it.
          line =
            `⚠  ${dep.name}${reason} — installed at ${resolvedPath}, ` +
            `but not on the MCP server's PATH; re-run \`barry setup\``;
          break;
        case "missing":
          line = `✗  ${dep.name}${reason} — missing${dep.install && status.packageInstallation?.state !== "installed" ? ` — install: ${dep.install}` : ""}`;
          break;
        case "unknown":
          // The caller passed a non-null path, so this branch means the
          // dependency check itself could not determine status.
          line =
            `?  ${dep.name}${reason} — found at ${resolvedPath}, ` +
            `reachability unverified`;
          break;
      }
      console.log(`  ${line}${packageInstallationSummary(status)}`);
    }
  }

  if (bag.requires.length > 0) {
    console.log("\nRequires:");
    const unmet = new Map(checkBagRequirements(bag).map((m) => [m.target, m]));
    for (const req of bag.requires) {
      const miss = unmet.get(req.target);
      const label = req.resource ? `${req.target}.${req.resource}` : req.target;
      const reason = req.reason ? ` (${req.reason})` : "";
      const status = miss ? (req.optional ? "✗ missing (optional)" : "✗ missing") : "✓";
      console.log(`  ${status}  ${label}${reason}`);
    }
  }

  if (source.type === "local" && bagNeedsInstall(source.path)) {
    console.log(`\n✗ npm dependencies not installed — run \`pnpm install\` in ${source.path}`);
  }

  if (bag.services.length > 0) {
    console.log("\nServices:");
    // Query the service management for live status; if it's not running, show without status
    const serviceStates = new Map<string, string>();
    try {
      const reply = await serviceRequest({ op: "status" });
      for (const s of reply.services) serviceStates.set(s.key, s.state);
    } catch (err) {
      if (!(err instanceof ServiceManagementError)) throw err;
      // Service management not running — show services without status indicator
    }
    for (const svc of bag.services) {
      const key = `${bag.name}.${svc.name}`;
      const state = serviceStates.get(key);
      const icon = state === "running" ? "●" : state ? "○" : "?";
      console.log(`  ${icon}  ${svc.name} — ${svc.description}`);
    }
  }

  if (bag.schedules.length > 0) {
    console.log("\nSchedules:");
    for (const schedule of bag.schedules) {
      const action = schedule.payload.kind === "inline" ? schedule.payload.manifest.description : schedule.payload.kind === "job" ? `job ${schedule.payload.ref}` : schedule.payload.ref;
      const off = schedule.enabled ? "" : " [disabled]";
      console.log(`  ${schedule.name} (${describeTrigger(schedule.trigger)}) — ${schedule.description ?? action}${off}`);
    }
  }
}

/**
 * Resolve an npm package specifier to the directory containing its
 * bag.yaml. Uses createRequire so resolution honors the current
 * project's node_modules layout (pnpm, npm, etc.).
 */
function resolveNpmBag(specifier: string): string | null {
  try {
    const req = createRequire(join(process.cwd(), "package.json"));
    // Try resolving the manifest directly (works when package.json exports
    // include "./bag.yaml" or the package has no exports field).
    try {
      const manifestPath = req.resolve(`${specifier}/bag.yaml`);
      return dirname(manifestPath);
    } catch {
      // Fall back to resolving the package entry and walking up to the
      // directory containing bag.yaml.
      const entry = req.resolve(specifier);
      let dir = dirname(entry);
      for (let depth = 0; depth < 8; depth++) {
        if (existsSync(join(dir, "bag.yaml"))) return dir;
        if (existsSync(join(dir, "package.json"))) return dir;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  } catch {
    // specifier not installed
  }
  return null;
}

/**
 * Render a bag-resolution warning in the CLI's voice.
 *
 * The wording is deliberately unchanged from when each of these was emitted
 * inline — this output is what people grep for when a bag misbehaves.
 */
function printBagWarnings(warnings: BagSyncWarning[]): void {
  for (const w of warnings) {
    switch (w.kind) {
      case "unregistered-bag":
        console.error(`Bag "${w.bag}" not registered. Add it first with: barry install`);
        break;
      case "unregistered-subbag":
        console.warn(`warning: sub-bag "${w.bag}" not registered, skipping`);
        break;
      case "missing-dependency":
        console.warn(`warning: ${w.message}${w.hint ? ` — install: ${w.hint}` : ""}`);
        break;
      default:
        console.warn(`warning: ${w.message}`);
    }
  }
}

/**
 * The barry a `bag enable`/`bag disable` invocation acts on. These aliases
 * take the barry as an option and fall back to the current default, which is
 * exactly why `barry pack <bag> --name <barry>` exists: the target barry is
 * explicit in the command rather than implied by the active one.
 */
async function resolveOptionBarry(options: { name?: string }): Promise<string> {
  const user = await getCurrentUser();
  const identityName = options.name || getActiveIdentity(user);
  if (!identityName) {
    throw new CliError("No Barry selected. Pass --name <name>, or create one with: barry identity create <name>", 1);
  }
  return identityName;
}

/**
 * The identity as it is actually in effect: from its directory when it has
 * one, the DB row otherwise.
 *
 * This read the DB row unconditionally. For a file-backed identity that row is
 * a cache of `identity.yaml`, which owns `bags` — so pack and unpack edited the
 * cache, printed success, and the next file-to-row sync put the old list back.
 */
async function requireIdentityByName(identityName: string) {
  // Lazy: identity.js carries the identity command surface, which every other
  // bag command (and every suite mocking child_process for them) has no use for.
  const { requireIdentity } = await import("./identity.js");
  return (await requireIdentity(identityName)).identity;
}

/**
 * Confirm pack/unpack by re-reading the authoritative identity bag list.
 * See docs/decisions/0036-cli-launch-and-persistence-rationale.md.
 */
async function confirmBagsPersisted(identityName: string, name: string, packed: boolean): Promise<void> {
  const bags = (await requireIdentityByName(identityName)).metadata.bags ?? [];
  if (bags.includes(name) !== packed) {
    console.error(
      `Error: "${name}" was ${packed ? "packed onto" : "unpacked from"} "${identityName}", ` +
        `but re-reading the identity shows it ${packed ? "absent" : "still present"}. Nothing will change for its sessions.`,
    );
    throw new CliError("", 1);
  }
}

/**
 * Add a bag to a barry. Shared by `barry pack` and its `bag enable`
 * alias, which differ only in how they arrive at `identityName`.
 */
async function addBagToIdentity(
  name: string,
  identityName: string,
  options: { optional?: boolean } = {},
): Promise<void> {
  // Registration is checked by installBlockers in bagPackCommand, against the
  // config store (the authoritative one). A second check here against
  // loadRegistry() would read the generated SNAPSHOT instead, so a bag that is
  // registered but whose snapshot has not been refreshed would be rejected with
  // "not registered" — and, worse, that check ran BEFORE the gate's own
  // disabled/unbuilt blockers could report the real problem.
  const identity = await requireIdentityByName(identityName);
  const existing = identity.metadata.bags ?? [];

  // Resolve before the idempotency check so sub-bag and dependency warnings
  // surface even when re-packing an already-enabled bag.
  const result = await resolveBags([name]);
  printBagWarnings(result.warnings);

  const merged = [...existing];
  for (const bag of result.bags) {
    if (!merged.includes(bag)) merged.push(bag);
  }

  const existingConfigs = (identity.metadata.bag_configs ?? {}) as Record<
    string,
    {
      optional?: boolean;
      tools?: Record<string, "enabled" | "deferred" | "disabled">;
      stores?: Record<string, { filepath?: string; url?: string }>;
    }
  >;
  const currentOptional = Boolean(existingConfigs[name]?.optional);
  const nextOptional = options.optional !== undefined ? Boolean(options.optional) : currentOptional;
  const optionalChanged = options.optional !== undefined && currentOptional !== nextOptional;

  if (merged.length === existing.length && !optionalChanged) {
    console.log(`Bag "${name}" already enabled on barry "${identityName}".`);
    return;
  }

  const nextBagConfigs =
    options.optional !== undefined
      ? {
          ...existingConfigs,
          [name]: {
            ...existingConfigs[name],
            ...(options.optional ? { optional: true } : { optional: undefined }),
          },
        }
      : undefined;

  printWarnings(
    (
      await Barry.identity(identity.name).update({
        bags: merged,
        ...(nextBagConfigs ? { bagConfigs: nextBagConfigs } : {}),
      })
    ).warnings,
  );
  await confirmBagsPersisted(identityName, name, true);
  console.log(`Bag "${name}" enabled on barry "${identityName}".`);

  // Children are NOT stored on the barry — composition is resolved every time
  // bags are loaded. Say "active via", not "enabled": unpacking the parent
  // takes them with it, and a manifest edit changes the set without a re-pack.
  for (const subBag of result.addedSubBags) {
    if (existing.includes(subBag)) continue;
    console.log(`  Sub-bag "${subBag}" active via "${name}".`);
  }

  // No setup needed: the service management starts services for registered bags when
  // it reconciles, triggered by install — packing just puts the bag on a barry.
}

/**
 * Remove a bag from a barry. Shared by `barry unpack` and its
 * `bag disable` alias.
 */
async function removeBagFromIdentity(name: string, identityName: string): Promise<void> {
  const identity = await requireIdentityByName(identityName);

  const bags = identity.metadata.bags ?? [];
  const wasPacked = bags.includes(name);
  if (wasPacked) {
    printWarnings((await Barry.identity(identity.name).update({ bags: bags.filter((p) => p !== name) })).warnings);
    await confirmBagsPersisted(identityName, name, false);
    console.log(`Bag "${name}" disabled on barry "${identityName}".`);
  } else {
    console.log(`Bag "${name}" not enabled on barry "${identityName}".`);
  }

  // Plists are NOT removed here. They follow registration, not membership:
  // the setup script installs them for every registered bag, so removing them
  // on unpack stopped the bag's services for every OTHER identity that packs
  // it, until the next setup run silently put them back. They go when the
  // registry entry goes — see bagUnpackCommand's --unregister.
}

/**
 * Set a bag's registry-wide access level (enabled | deferred | disabled).
 * This is orthogonal to `barry pack`/`unpack`, which manage
 * per-barry membership — `access` controls how the bag's tools appear in every session:
 *   enabled  — tools listed normally
 *   deferred — tools hidden from tools/list but discoverable via tool_search
 *   disabled — block off entirely
 */
export async function bagAccessCommand(name: string, level: string): Promise<void> {
  const valid: BagAccessLevel[] = ["enabled", "deferred", "disabled"];
  if (!valid.includes(level as BagAccessLevel)) {
    throw new CliError(`Invalid access level "${level}". Use one of: ${valid.join(", ")}`, 1);
  }

  const source = getBagSource(name);
  if (!source) {
    throw new CliError(`Bag "${name}" is not registered. Add it with: barry install <path-or-url> --name ${name}`, 1);
  }

  // Migrate the legacy `disabled` boolean into the unified `access` field.
  const updated: BagSource = { ...source, access: level as BagAccessLevel };
  delete (updated as { disabled?: boolean }).disabled;
  await upsertBag(name, updated);
  console.log(`Bag "${name}" access set to "${level}".`);

  // A disabled bag's services stop, and a re-enabled bag's start, with no
  // setup rerun: the service management reads access from the registry.
  const reconciled = await reconcileServices();
  if (reconciled && (reconciled.started.length || reconciled.stopped.length)) {
    const changes = [
      ...(reconciled.started.length ? [`started ${reconciled.started.join(", ")}`] : []),
      ...(reconciled.stopped.length ? [`stopped ${reconciled.stopped.join(", ")}`] : []),
    ];
    console.log(`  service management: ${changes.join("; ")}`);
  }

  if (await restartManagedService(MCP_SERVER_KEY)) {
    console.log("MCP server restarted — the change applies to new sessions.");
  } else {
    console.log("Hint: run `barry service restart mcp.server` to apply the change.");
  }
}


/**
 * Authenticate with a bag's MCP server (OAuth flow).
 * Spawns mcp-remote interactively so the user can complete browser-based auth.
 * Cached tokens are reused by the barry MCP server's bag proxy.
 */
export async function bagAuthCommand(name: string): Promise<void> {
  const registry = loadRegistry();
  const source = registry[name];
  if (!source) {
    throw new CliError(`Bag "${name}" not found. Run: barry bag list`, 1);
  }

  if (source.type === "local") {
    const bagResult = loadBag(name);
    const bag = bagResult instanceof Promise ? await bagResult : bagResult;
    if (!bag) {
      throw new CliError(`Bag "${name}" could not be loaded.`, 1);
    }

    // CLI-delegated auth: the vendor's own CLI ships the OAuth flow
    // (e.g. `temporal cloud login`). Run its check first, then the
    // interactive login. Credentials live in the vendor CLI's store.
    if (bag.manifest?.auth) {
      const auth = bag.manifest.auth;
      if (auth.check) {
        const ok = await runInteractive(auth.check.command, auth.check.args ?? [], { quiet: true });
        if (ok) {
          console.log(`Bag "${name}" is already authenticated (${auth.check.command} ${(auth.check.args ?? []).join(" ")} succeeded).`);
          return;
        }
      }
      console.log(`Running: ${auth.command} ${(auth.args ?? []).join(" ")}`);
      const ok = await runInteractive(auth.command, auth.args ?? []);
      if (!ok) {
        throw new CliError(`Auth command failed.`, 1);
      }
      console.log(`Bag "${name}" authenticated.`);
      return;
    }

    const oauthServers: { name: string; url: string }[] = [];
    for (const [serverName, server] of Object.entries(bag.mcpServers)) {
      if (server.url && !server.env?.length) {
        try {
          const parsed = new URL(server.url);
          if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
            oauthServers.push({ name: serverName, url: server.url });
          }
        } catch { /* invalid URL, skip */ }
      }
    }

    if (oauthServers.length === 0) {
      throw new CliError(`Bag "${name}" has no MCP servers that need OAuth.`, 1);
    }

    for (const server of oauthServers) {
      console.log(`\nAuthenticating MCP server "${server.name}" (${server.url})...`);
      await runOAuthFlow(server.name, server.url, {});
    }

    // Restart MCP server to pick up fresh tokens
    console.log("\nRestarting MCP server to pick up new tokens...");
    if (await restartManagedService(MCP_SERVER_KEY)) {
      console.log("MCP server restarted — bag tools will be available in new sessions.");
    } else {
      console.log("Hint: run `barry service restart mcp.server` to make new tokens available.");
    }
    return;
  }

  const remote = source;

  // API-key bags (env vars / --header args) authenticate with headers, not
  // OAuth. Running mcp-remote's browser flow for them always fails — the
  // server rejects the dynamically-registered OAuth client (e.g. Datadog
  // redirects back without a `code` param → "No authorization code received").
  if (!isOAuthBag(remote)) {
    const declared = getDeclaredEnvVars(remote);
    if (declared.length === 0) {
      console.log(`Bag "${name}" does not use OAuth — no auth needed.`);
      return;
    }

    const missing = declared.filter((v) => !process.env[v]);
    if (missing.length === 0) {
      console.log(`Bag "${name}" authenticates with API keys (${declared.join(", ")}) — all are set. No OAuth needed.`);
      return;
    }

    throw new CliError(`Bag "${name}" authenticates with API keys (${declared.join(", ")}), not OAuth.` + "\n" + `Missing from this shell: ${missing.join(", ")}.` + "\n" + `Set them in the environment Barry runs under (service env / shell barry), then restart services.`, 1);
  }

  let url: string | undefined;
  if (remote.url) {
    url = remote.url;
  } else if (remote.command === "npx" && remote.args) {
    const remoteIdx = remote.args.indexOf("mcp-remote");
    if (remoteIdx >= 0 && remote.args[remoteIdx + 1]) {
      const candidate = remote.args[remoteIdx + 1];
      if (candidate.startsWith("http")) url = candidate;
    }
  }

  if (!url) {
    throw new CliError(`Bag "${name}" doesn't have an MCP server URL to authenticate with.`, 1);
  }

  console.log(`Authenticating with ${name} (${url})...`);

  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (remote.env) {
    for (const varName of remote.env) {
      if (process.env[varName]) env[varName] = process.env[varName]!;
    }
  }

  const extraArgs: string[] = [];
  const unsetVars = new Set<string>();
  if (remote.args) {
    const remoteIdx = remote.args.indexOf("mcp-remote");
    if (remoteIdx >= 0) {
      for (let i = remoteIdx + 2; i < remote.args.length; i++) {
        let arg = remote.args[i];
        arg = arg.replace(/\$\{(\w+)\}/g, (_: string, v: string) => {
          if (!env[v]) unsetVars.add(v);
          return env[v] || "";
        });
        extraArgs.push(arg);
      }
    }
  }

  if (unsetVars.size > 0) {
    throw new CliError(`Bag "${name}" needs environment variable(s) that are not set: ${[...unsetVars].join(", ")}.` + "\n" + "Set them in this shell (or Barry's service environment) and retry.", 1);
  }

  await runOAuthFlow(name, url, env, extraArgs);

  // Restart MCP server so it picks up fresh tokens immediately
  console.log("Restarting MCP server to pick up new tokens...");
  if (await restartManagedService(MCP_SERVER_KEY)) {
    console.log("MCP server restarted — bag tools will be available in new sessions.");
  } else {
    console.log("Hint: run `barry service restart mcp.server` to make new tokens available.");
  }
}

/**
 * Run a vendor CLI command interactively (stdio inherited so browser-based
 * flows and prompts work). Resolves true on exit code 0.
 * With `quiet`, output is suppressed — used for auth `check` commands.
 */
function runInteractive(
  command: string,
  args: string[],
  options: { quiet?: boolean } = {},
): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      stdio: options.quiet ? "ignore" : "inherit",
      env: process.env,
    });
    child.on("error", () => resolvePromise(false));
    child.on("exit", (code) => resolvePromise(code === 0));
  });
}

/**
 * Spawn mcp-remote to perform an OAuth handshake for a given URL.
 * Polls for cached tokens and kills the child process once they appear.
 */
async function runOAuthFlow(
  label: string,
  url: string,
  env: Record<string, string>,
  extraArgs: string[] = [],
): Promise<void> {
  console.log("A browser window will open for authorization.\n");

  const args = ["-y", "mcp-remote", url, ...extraArgs];

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("npx", args, {
      stdio: "inherit",
      env: { ...process.env, ...env },
    });

    // Poll for token file every 2s instead of using a blind timer.
    // mcp-remote caches tokens to ~/.mcp-auth/ once OAuth completes.
    const AUTH_TIMEOUT_MS = 120_000;
    const POLL_INTERVAL_MS = 2_000;
    let done = false;

    const poll = setInterval(() => {
      if (done) return;
      if (hasOAuthTokens(url)) {
        done = true;
        clearInterval(poll);
        clearTimeout(timeout);
        console.log("\nAuthorization complete. Tokens cached for the barry MCP server.");
        child.kill();
        resolvePromise();
      }
    }, POLL_INTERVAL_MS);

    const timeout = setTimeout(() => {
      if (done) return;
      done = true;
      clearInterval(poll);
      console.log("\nAuthorization timed out. Run `barry bag auth " + label + "` to try again.");
      child.kill();
      resolvePromise();
    }, AUTH_TIMEOUT_MS);

    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timeout);
      if (code === 0 || code === null) {
        resolvePromise();
      } else {
        reject(new Error(`mcp-remote exited with code ${code}`));
      }
    });

    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/** Kinds `barry new` can scaffold, beyond a bag. */
const SCAFFOLD_KINDS = ["bag", "action", "instruction", "bound"] as const;
type ScaffoldKind = (typeof SCAFFOLD_KINDS)[number];

/**
 * Resolve the bag a non-bag scaffold lands in.
 *
 * `--bag <name>` resolves through the registry so it works from anywhere.
 * Without it, the cwd must itself be a bag — inferring the "current" bag from
 * a parent directory would silently write into the wrong bag from a subdir.
 */
function resolveTargetBagDir(bagName: string | undefined): string {
  if (bagName) {
    const bag = loadBagSync(bagName);
    if (!bag) throw new Error(`Unknown bag: ${bagName}`);
    if (bag.source.type !== "local") throw new Error(`Bag "${bagName}" is remote — nothing to scaffold into.`);
    return bag.source.path.replace(/^~/, homedir());
  }
  if (!existsSync(join(process.cwd(), "bag.yaml"))) {
    throw new Error("Not inside a bag (no bag.yaml here). Pass --bag <name>.");
  }
  return process.cwd();
}

/**
 * `barry new <kind> <name>` — scaffold a bag, action, instruction, or bound.
 *
 * `barry new <name>` (no kind) still scaffolds a bag: that is the documented
 * spelling and what every existing doc and muscle memory expects. The kind is
 * detected rather than required, so adding kinds did not invalidate the old
 * form.
 */
export async function newCommand(
  first: string,
  second: string | undefined,
  options: {
    path?: string;
    server?: boolean;
    template?: "local" | "npm";
    bag?: string;
    description?: string;
    mode?: "always" | "on-demand";
  },
): Promise<void> {
  const isKind = (SCAFFOLD_KINDS as readonly string[]).includes(first);

  // `barry new action` with no name is a mistake worth catching: it would
  // otherwise scaffold a BAG literally named "action".
  if (isKind && first !== "bag" && !second) {
    throw new CliError(`Error: barry new ${first} requires a name — e.g. barry new ${first} my-${first}`, 1);
  }

  const kind: ScaffoldKind = isKind ? (first as ScaffoldKind) : "bag";
  const name = isKind ? (second ?? first) : first;

  if (kind === "bag") {
    await bagCreateCommand(name, options);
    return;
  }

  try {
    const bagDir = resolveTargetBagDir(options.bag);
    const result =
      kind === "action"
        ? scaffoldActionDir({ bagDir, name, description: options.description })
        : kind === "instruction"
          ? scaffoldInstruction({ bagDir, name, description: options.description, mode: options.mode })
          : scaffoldBound({
              bagDir,
              name,
              description: options.description,
            });

    for (const file of result.files) console.log(`Created ${file}`);
    if (result.hint) console.log(`\n${result.hint}`);
  } catch (err: unknown) {
    if (isCliError(err)) throw err;
    throw new CliError(`Error: ${err instanceof Error ? err.message : String(err)}`, 1);
  }
}

export async function bagCreateCommand(
  name: string,
  options: { path?: string; server?: boolean; template?: "local" | "npm" },
): Promise<void> {
  const template = options.template ?? "local";
  const bagPath = options.path || resolve(name);

  try {
    scaffoldBag({ name, path: bagPath, withServer: options.server, template });
    console.log(`Bag "${name}" created at ${bagPath}`);
    console.log("\nGenerated:");
    console.log("  bag.yaml  — manifest");
    console.log("  skills/          — skills directory");
    if (options.server) {
      if (template === "npm") {
        console.log("  src/server.ts       — MCP server entry");
        console.log("  package.json        — dependencies (@barry-rocks/sdk/tools)");
        console.log("  tsconfig.json       — TypeScript config");
        console.log("  tsconfig.build.json — build config (tsc)");
      } else {
        console.log("  server.ts        — MCP server (barry:// resources)");
        console.log("  package.json     — dependencies");
        console.log("  tsconfig.json    — TypeScript config");
      }
    }
    if (template === "npm") {
      console.log(`\nThis bag uses @barry-rocks/sdk/bags. Install deps: cd ${bagPath} && pnpm install`);
    }
    console.log(`\nInstall it with: barry install ${bagPath}`);
  } catch (err: unknown) {
    if (isCliError(err)) throw err;
    throw new CliError(`Error: ${err instanceof Error ? err.message : String(err)}`, 1);
  }
}

/**
 * Build local bags to plain JavaScript.
 *
 * Bags are bundled ahead of time so the MCP server never imports raw
 * TypeScript at runtime — see sdk/src/bags/build.ts for why that matters.
 *
 * Returns whether every bag built. Callers in the install path MUST check it:
 * a build failure that only sets `process.exitCode` is invisible to them, so
 * `barry install` printed "Installed." over a bag that built zero tools.
 */
export async function bagBuildCommand(
  name: string | undefined,
  options: { force?: boolean; watch?: boolean; ifStale?: boolean },
): Promise<boolean> {
  const { buildBags, linkExternals, discoverBuildableBags, writeBuildMarker } =
    await import("@barry-rocks/sdk/internal/bags");
  const { getBagsBuildRoot } = await import("@barry-rocks/sdk/internal/bags");

  const only = name ? [name] : undefined;
  if (name && !discoverBuildableBags().some((p) => p.name === name)) {
    console.error(`Bag '${name}' is not a local bag with a tools entry.`);
    process.exitCode = 1;
    return false;
  }

  writeBuildMarker();
  const { missing } = linkExternals(process.cwd());
  if (missing.length > 0) {
    console.log(`  note: could not link ${missing.join(", ")} (bags needing them may fail to load)`);
  }

  const run = async (): Promise<boolean> => {
    const started = Date.now();
    const results = await buildBags({ force: options.force ?? false, only, ifStale: options.ifStale });
    const ok = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);

    // Print each structured build diagnostic; a count header alone hides the actionable error.
    // Rationale: docs/decisions/0009-runtime-and-fixture-invariants.md#note-001
    for (const failure of failed) {
      if (failure.errors?.length) {
        console.error(`  ✗ ${failure.name}:`);
        for (const e of failure.errors) {
          const where = e.file ? `${e.file}${e.line ? `:${e.line}` : ""}${e.column !== undefined ? `:${e.column}` : ""}: ` : "";
          console.error(`      ${where}${e.text}`);
        }
      } else {
        // No structured diagnostics (not an esbuild failure) — print the whole
        // message rather than its first line.
        const lines = String(failure.error).split("\n").filter((l) => l.trim());
        console.error(`  ✗ ${failure.name}: ${lines[0] ?? "build failed"}`);
        for (const l of lines.slice(1)) console.error(`      ${l}`);
      }
    }

    const totalBytes = ok.reduce((sum, r) => sum + (r.bytes ?? 0), 0);
    console.log(
      `Built ${ok.length}/${results.length} bags in ${((Date.now() - started) / 1000).toFixed(1)}s ` +
        `(${(totalBytes / 1e6).toFixed(1)}MB) → ${getBagsBuildRoot().replace(process.env.HOME || "", "~")}`,
    );
    return failed.length === 0;
  };

  const ok = await run();
  if (!ok) process.exitCode = 1;

  if (options.watch) {
    const { watch } = await import("fs");
    const bags = discoverBuildableBags().filter((p) => !name || p.name === name);
    console.log(`Watching ${bags.length} bag(s) — Ctrl-C to stop`);

    let timer: NodeJS.Timeout | undefined;
    const rebuild = (): void => {
      clearTimeout(timer);
      // Debounce: editors emit several events per save.
      timer = setTimeout(() => void run(), 150);
    };

    for (const bag of bags) {
      watch(bag.bagDir, { recursive: true }, (_event, file) => {
        if (typeof file === "string" && file.endsWith(".ts") && !file.endsWith(".test.ts")) rebuild();
      });
    }

    await new Promise(() => {});
  }

  return ok;
}

/**
 * Serve a local bag over MCP so it can be consumed as a remote bag.
 *
 * Doubles as the dogfooding path for the remote route: serve a known-good local
 * bag, register it as remote, and the two should present the same capabilities.
 */
export async function bagServeCommand(
  name: string,
  options: { port?: string; host?: string },
): Promise<void> {
  const { serveBagOverHttp } = await import("@barry-rocks/sdk/mcp");

  const source = getBagSource(name);
  if (!source) {
    console.error(`Bag '${name}' is not registered.`);
    process.exitCode = 1;
    return;
  }
  if (source.type !== "local") {
    console.error(`Bag '${name}' is already remote — only local bags can be served.`);
    process.exitCode = 1;
    return;
  }

  const bagDir = source.path.replace(/^~/, process.env.HOME || "");
  const port = Number(options.port ?? 9878);
  if (!Number.isInteger(port) || port <= 0) {
    console.error(`Invalid port: ${options.port}`);
    process.exitCode = 1;
    return;
  }

  const { url, close } = await serveBagOverHttp({ bagDir, port, host: options.host });

  console.log(`Serving bag '${name}' from ${bagDir}`);
  console.log(`  ${url}`);
  console.log(`\nRegister it as a remote bag with:`);
  console.log(`  barry install ${url} --name ${name}-remote`);
  console.log(`  (then add 'resources: true' to the entry to pull skills/bounds)`);

  const shutdown = (): void => {
    void close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {});
}

/**
 * Publish @barry-rocks/sdk/tools to npm.
 *
 * Runs: clean tree check → test → build → pnpm publish --access public.
 * No changesets — one package, one maintainer, independent versioning.
 */
export async function bagPublishSdkCommand(options: { dryRun?: boolean }): Promise<void> {
  const sdkDir = join(resolve("."), "sdk", "bags");
  if (!existsSync(join(sdkDir, "package.json"))) {
    throw new CliError("sdk/bags not found — run from the repo root", 1);
  }

  const gitStatus = spawnSync("git", ["status", "--porcelain", "--", sdkDir], { encoding: "utf-8" });
  if (gitStatus.stdout.trim()) {
    throw new CliError("Working tree has uncommitted changes in sdk/bags:" + "\n" + gitStatus.stdout, 1);
  }

  console.log("Running tests…");
  const testResult = spawnSync("pnpm", ["--filter", "@barry-rocks/sdk/tools", "test"], {
    encoding: "utf-8",
    stdio: "inherit",
  });
  if (testResult.status !== 0) {
    throw new CliError("Tests failed — aborting publish.", 1);
  }

  console.log("Building…");
  const buildResult = spawnSync("pnpm", ["--filter", "@barry-rocks/sdk/tools", "build"], {
    encoding: "utf-8",
    stdio: "inherit",
  });
  if (buildResult.status !== 0) {
    throw new CliError("Build failed — aborting publish.", 1);
  }

  // Verify dist preserves type inference
  if (!existsSync(join(sdkDir, "dist", "index.d.ts"))) {
    throw new CliError("dist/index.d.ts missing — build did not produce type declarations", 1);
  }

  const publishArgs = ["publish", "--access", "public"];
  if (options.dryRun) publishArgs.push("--dry-run");

  console.log(options.dryRun ? "Dry run…" : "Publishing…");
  const publishResult = spawnSync("pnpm", publishArgs, {
    encoding: "utf-8",
    stdio: "inherit",
    cwd: sdkDir,
  });

  if (publishResult.status !== 0) {
    throw new CliError("Publish failed.", 1);
  }

  if (options.dryRun) {
    console.log("\nDry run complete — no package was published.");
  } else {
    const pkg = JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf-8"));
    console.log(`\n✓ @barry-rocks/sdk/bags@${pkg.version} published to npm`);
  }
}

/**
 * Audit identity bag lists against the bag registry and runtime state, with
 * optional repairs. See docs/decisions/0036-cli-launch-and-persistence-rationale.md.
 */

interface OAuthHealthResult {
  server: string;
  bag: string;
  url: string;
  status: "ok" | "expired" | "missing" | "refreshed" | "refresh_failed";
}

/**
 * Check OAuth token health for all HTTP-type MCP servers across loaded bags.
 *
 * For each `type: http` server with a non-localhost URL, checks whether a
 * cached OAuth token exists and whether it has expired. Returns a status
 * per server so the caller can report or attempt refresh.
 */
async function checkOAuthHealth(
  bags: Awaited<ReturnType<typeof loadAllBags>>,
  attemptRefresh: boolean,
): Promise<OAuthHealthResult[]> {
  const results: OAuthHealthResult[] = [];
  const seen = new Set<string>();

  for (const bag of bags) {
    for (const [serverName, server] of Object.entries(bag.mcpServers)) {
      if (!server.url) continue;
      // Skip localhost servers — they don't use OAuth
      try {
        const parsed = new URL(server.url);
        if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") continue;
      } catch {
        continue;
      }
      // Skip command-transport servers that happen to have a URL embedded in args
      if (server.command && !server.type) continue;

      // Deduplicate by URL — multiple bags can declare the same server
      if (seen.has(server.url)) continue;
      seen.add(server.url);

      const token = getOAuthAccessToken(server.url);
      if (token) {
        results.push({ server: serverName, bag: bag.name, url: server.url, status: "ok" });
        continue;
      }

      if (!hasOAuthTokens(server.url)) {
        results.push({ server: serverName, bag: bag.name, url: server.url, status: "missing" });
        continue;
      }

      if (attemptRefresh) {
        const refreshed = await refreshOAuthToken(server.url);
        results.push({
          server: serverName,
          bag: bag.name,
          url: server.url,
          status: refreshed ? "refreshed" : "refresh_failed",
        });
      } else {
        results.push({ server: serverName, bag: bag.name, url: server.url, status: "expired" });
      }
    }
  }

  return results;
}

/**
 * Compare the generated snapshot against the authoritative table.
 *
 * Reads both sides and hands them to the pure comparison in
 * snapshot-drift.ts. The previous version compared NAMES only, reasoning that
 * builtin paths are stored relative and resolved at write time so a value-level
 * diff would flag every builtin on every run. That reason is real, but the
 * answer to it is to resolve the database side the SAME way the writer does —
 * which is what `snapshotSourceOf` below exists for — not to stop comparing
 * values. See snapshot-drift.ts for what the names-only version could not see.
 */
async function findSnapshotDrift(): Promise<string[]> {
  const path = getRegistrySnapshotPath();
  const rows = await listBags();

  if (!existsSync(path)) {
    return [
      `snapshot missing (${path}) — CLI groups, completion and hook dispatch are falling back to YAML`,
    ];
  }

  let snapshot: Map<string, SnapshotEntry>;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    snapshot = new Map(Object.entries((parsed?.bags ?? {}) as Record<string, SnapshotEntry>));
  } catch {
    return [`snapshot unreadable (${path}) — regenerate it`];
  }

  // Resolved exactly as writeRegistrySnapshot would write it, so a builtin's
  // relative path is not mistaken for drift against its own resolved form.
  const db = new Map(rows.map((r) => [r.name, snapshotSourceOf(r) as SnapshotEntry]));

  return findSnapshotDriftBetween({
    db,
    snapshot,
    exists: existsSync,
    expand: (p) => resolve(p.replace(/^~/, homedir())),
  });
}

const PERMISSION_PANES: Record<BagPermission["kind"], string> = {
  automation: "Automation",
  accessibility: "Accessibility",
  "screen-recording": "Screen & System Audio Recording",
  "full-disk-access": "Full Disk Access",
};

/**
 * The macOS privacy permissions installed bags declare, and where each is
 * granted. Reported, not verified: macOS lets a program read only its own
 * grants, and the program that needs these is the node the service management runs
 * the bags' tools and services with, not this CLI. A denied Apple event fails
 * silently inside a tool, so saying up front what to grant is the useful part.
 */
export function reportPermissions(
  bags: Array<Pick<Bag, "name"> & { manifest: { permissions?: BagPermission[] } | null }>,
  node = stableNodePath(),
): void {
  const declared = bags.flatMap((bag) => (bag.manifest?.permissions ?? []).map((permission) => ({ bag: bag.name, permission })));
  if (declared.length === 0) return;
  console.log(`
macOS permissions bags declare (grant each to ${node}; doctor cannot read another program's grants):`);
  for (const { bag, permission } of declared) {
    const what = permission.kind === "automation" ? `Automation → ${permission.app}` : PERMISSION_PANES[permission.kind];
    console.log(`  ○ ${bag}: ${what} — ${permission.reason}`);
    console.log(`      System Settings › Privacy & Security › ${PERMISSION_PANES[permission.kind]}`);
  }
}

export async function reportBagManifestProblems(fix: boolean): Promise<number> {
  const registry = loadRegistry();
  let count = 0;
  for (const [name, source] of Object.entries(registry)) {
    if (source.type !== "local" || source.npm || isBuiltinBag(name)) continue;
    const bagDir = resolveBuiltinPath(source.path.replace(/^~/, homedir()));
    const manifestPath = join(bagDir, "bag.yaml");
    if (!existsSync(manifestPath)) continue;
    let rawYaml = "";
    try {
      rawYaml = readFileSync(manifestPath, "utf-8");
    } catch {
      continue;
    }
    if (!rawYaml.trim()) continue;
    let parsedDoc: unknown;
    try {
      parsedDoc = parseYaml(rawYaml);
    } catch {
      continue;
    }
    if (!parsedDoc || typeof parsedDoc !== "object" || Array.isArray(parsedDoc)) continue;
    const { updated, changes } = migrateBagManifestObject(parsedDoc as Record<string, unknown>, name);
    if (changes.length === 0) continue;

    count++;
    console.log(`\nBag "${name}" manifest uses legacy keys (${changes.join("; ")}):`);
    console.log(`  ✗ ${manifestPath}: run barry bag doctor --fix to migrate`);
    if (fix) {
      try {
        backupBeforeDoctorWrite(manifestPath, `bags/${name}/bag.yaml`);
      } catch {
        // Backup best-effort when fs is mocked in unit tests
      }
      writeFileSync(manifestPath, stringifyYaml(updated), "utf-8");
      console.log(`  ✓ Migrated ${manifestPath} (${changes.join("; ")})`);
    }
  }
  return count;
}

export async function bagDoctorCommand(options: { fix?: boolean }): Promise<void> {
  if (options.fix) await (await import("../services/barry.js")).prepareBagRegistry();
  const registry = loadRegistry();
  // Each identity as it is in effect: its directory when it has one.
  const owned = await owner.current() ? (await identityRecords.list()).map((entry) => entry.record) : [];

  // Query the service management for service status. When no service management is running,
  // service checks are skipped (not a failure — the user may be running
  // `doctor` before `barry up`).
  let managedServices: ServiceStatus[] | null = null;
  try {
    if (existsSync(serviceRegistryPath())) {
      const reply = await serviceRequest({ op: "status" });
      managedServices = reply.services;
    }
  } catch (err) {
    if (!(err instanceof ServiceManagementError)) throw err;
    // No service management running — service checks skipped below.
  }
  const managedServiceByKey = new Map(managedServices?.map((s) => [s.key, s]) ?? []);

  const bagCache = new Map<string, Awaited<ReturnType<typeof loadBag>>>();
  async function bagOf(name: string) {
    if (!bagCache.has(name)) {
      const result = loadBag(name);
      bagCache.set(name, result instanceof Promise ? await result : result);
    }
    return bagCache.get(name) ?? null;
  }

  /** The registry path of a local bag that is not on disk, else null. */
  function missingLocalPath(source: (typeof registry)[string] | undefined): string | null {
    if (!source || source.type !== "local" || !source.path) return null;
    const expanded = source.path.replace(/^~/, process.env.HOME ?? "");
    return existsSync(expanded) ? null : source.path;
  }

  /** The git provenance of a registry entry, when Barry fetched it. */
  function gitSourceOf(
    source: (typeof registry)[string] | undefined,
  ): { repo: string; rev?: string; ref?: string } | null {
    if (!source || source.type !== "local") return null;
    return source.git ?? null;
  }

  /**
   * Ways a fetched bag's checkout can stop matching what was registered.
   *
   * Without this, a git-sourced bag is checked no more deeply than "the path
   * exists" — and a directory can exist while being a different repository
   * entirely, or sitting on a commit nobody pinned. Both load fine and hand
   * out the wrong code, which is indistinguishable from the right code until
   * something behaves oddly.
   *
   * Reported, never repaired: the checkout may hold work in progress, and
   * moving it is the user's call.
   */
  function gitCheckoutProblems(name: string, source: (typeof registry)[string] | undefined): string[] {
    const git = gitSourceOf(source);
    if (!git || !source || source.type !== "local") return [];
    const dir = source.path.replace(/^~/, process.env.HOME ?? "");

    const origin = originOf(dir);
    if (!origin) {
      return [`bag "${name}" was fetched from ${git.repo} but ${source.path} is no longer a git checkout`];
    }
    if (!sameRemote(origin, git.repo)) {
      return [`bag "${name}" should be ${git.repo} but ${source.path} points at ${origin}`];
    }
    // Only a pinned bag has an expected commit; a branch-tracking one is
    // supposed to move, so reporting its drift would be noise.
    if (git.rev) {
      const head = headOf(dir);
      if (head && head !== git.rev) {
        return [
          `bag "${name}" is pinned at ${git.rev.slice(0, 8)} but ${source.path} is on ${head.slice(0, 8)}`,
        ];
      }
    }
    return [];
  }

  /**
   * Bags get moved between parent directories (the pack→bag rename moved
   * every one of them). If the same basename exists under a sibling root, say
   * so — otherwise the only clue is a bag that silently contributes nothing.
   */
  function findRelocatedPath(registryPath: string): string | null {
    const home = process.env.HOME ?? "";
    const expanded = registryPath.replace(/^~/, home);
    const base = expanded.split("/").filter(Boolean).pop();
    if (!base) return null;
    for (const root of [join(home, "repos", "bags"), join(home, "repos", "packs")]) {
      const candidate = join(root, base);
      if (candidate !== expanded && existsSync(candidate)) return candidate.replace(home, "~");
    }
    return null;
  }

  let problemCount = 0;
  const identitiesToFix: Array<{ id: number; name: string; actor_id: number; bags: string[] }> = [];

  /**
   * Host binaries are checked against the MCP SERVER's PATH, not this CLI's.
   *
   * Doctor had no binary check at all, so the failure that motivated it —
   * clickhousectl installed in ~/.local/bin, absent from the service PATH, and
   * reported by the tool as "not installed" — was invisible here. Reading the
   * server's own PATH is what makes this able to fail: resolving against
   * process.env would inherit this shell's PATH and pass in exactly the case
   * that is broken.
   *
   * Computed once; the loop below visits a shared bag once per identity.
   */
  const serverPath = serviceLaunchPath();
  const reportedDeps = new Set<string>();

  const allRegistryBags = await loadAllBags();

  for (const barry of owned) {
    const bags = barry.metadata.bags ?? [];
    if (bags.length === 0) continue;

    const problems: string[] = [];

    for (const name of bags) {
      if (!(name in registry)) {
        problems.push(`stale reference: bag "${name}" is not in the registry`);
        continue;
      }

      const missingPath = missingLocalPath(registry[name]);
      if (missingPath) {
        const moved = findRelocatedPath(missingPath);
        const git = gitSourceOf(registry[name]);
        problems.push(
          `bag "${name}" path does not exist: ${missingPath}` +
            (moved
              ? ` — did it move to ${moved}?`
              : git
                ? ` — re-fetch it with: barry install ${git.repo}`
                : ""),
        );
        continue;
      }

      problems.push(...gitCheckoutProblems(name, registry[name]));

      const bag = await bagOf(name);
      if (!bag) {
        problems.push(`bag "${name}" could not be loaded (disabled?)`);
        continue;
      }

      // Host binaries the bag's tools shell out to. "Installed but unreachable"
      // is reported separately from "missing" because reinstalling does not fix
      // the first one — regenerating the service PATH does.
      for (const status of checkBagDependencyStates(bag, serverPath)) {
        if (status.state === "ok") continue;
        if (status.dependency.optional) {
          console.log(`  optional dependency ${name}:${status.dependency.name}: ${status.state}${packageInstallationSummary(status)}`);
          continue;
        }
        const key = `${name}:${status.dependency.name}`;
        if (reportedDeps.has(key)) continue;
        reportedDeps.add(key);

        const dep = status.dependency.name;
        if (status.state === "unreachable") {
          problems.push(
            `bag "${name}" dependency "${dep}" is installed at ${status.resolvedPath} but not on ` +
              `the MCP server's PATH, so its tools cannot run it — run: barry setup`,
          );
        } else if (status.state === "missing") {
          problems.push(
            `bag "${name}" dependency "${dep}" executable was not found${packageInstallationSummary(status)}` +
              (status.dependency.install && status.packageInstallation?.state !== "installed" ? ` — install: ${status.dependency.install}` : ""),
          );
        } else {
          // unknown: the server's PATH could not be read. Say so rather than
          // implying the dependency is fine.
          problems.push(
            `bag "${name}" dependency "${dep}" found at ${status.resolvedPath}, but the MCP ` +
              `server's PATH could not be read — reachability unverified`,
          );
        }
      }

      // No sub-bag "is not enabled" check here, deliberately.
      //
      // It asserted that a parent's children were present in the stored list,
      // which was only ever true because pack time flattened them in. That made
      // a cache-staleness artifact look like a broken bag: the reported fix was
      // a re-pack, and the bag itself was fine either way. Composition is now
      // resolved wherever bags are loaded, so a child absent from the list is
      // the normal, correct state. The reverse case — a child sitting in the
      // list redundantly — is reported below as an advisory, not an error.

      // Check services against the service management (when running). Include privileged daemons in their actual system domain.
      if (managedServices !== null) {
        for (const svc of bag.services) {
          const key = `${name}.${svc.name}`;
          const status = managedServiceByKey.get(key);
          if (!status) {
            problems.push(`service "${key}" is not known to service management — run: barry service add ${key}`);
          } else if (status.state === "conflict") {
            problems.push(`service "${key}" has a port conflict — held by ${status.conflict}`);
          } else if (status.problem) {
            problems.push(`service "${key}": ${status.problem}`);
          } else if (status.loopbackOnly === false) {
            problems.push(`service "${key}" is bound to a non-loopback address`);
          } else if (status.state === "backoff") {
            problems.push(`service "${key}" is in backoff — check its logs with: barry service logs ${key}`);
          }
        }
      }


      if (bag.manifest?.infra && bag.source.type === "local") {
        const bagDir = resolve(bag.source.path.replace(/^~/, process.env.HOME ?? ""));
        const infraDir = resolve(bagDir, bag.manifest.infra.root);
        if (!existsSync(infraDir)) {
          problems.push(`bag "${name}" declares infra root "${bag.manifest.infra.root}" but directory does not exist`);
        } else {
          const tfFiles = readdirSync(infraDir).filter((f) => f.endsWith(".tf"));
          if (tfFiles.length === 0) {
            problems.push(`bag "${name}" declares infra root "${bag.manifest.infra.root}" but it contains no .tf files`);
          }
        }
      }

      const config = identityRecords.config(barry);
      const definitions = await loadBagToolDefinitions(bag) ?? [];
      const tools = applyToolVisibility(definitions, bag.manifest?.toolVisibility ?? {}, config.bag_configs[name]?.tools ?? {});
      const declared = new Set(Object.keys(config.secrets));
      const required = new Set(tools.flatMap((tool) => tool.secrets ?? []));
      const unbound = [...required].filter((secretName) => !declared.has(secretName));
      if (unbound.length) problems.push(`bag "${name}" needs unbound secrets: ${unbound.join(", ")}`);

    }

    /**
     * A bag that is BOTH packed and reachable via another bag's composition is
     * not reported, deliberately.
     *
     * Packing is a statement of intent — "I want this bag" — and composition is
     * a statement about how bags relate. A bag can be both without either being
     * wrong, and the session is identical either way because expansion dedupes.
     * Reporting it invites unpacking something the user explicitly asked for,
     * on the grounds that a parent happens to pull it in today. If that parent
     * later drops the child from its `bags:`, the explicit pack is what keeps
     * the bag working — which is the whole point of having asked for it.
     */

    if (problems.length === 0) continue;
    problemCount += problems.length;
    console.log(`\nBarry "${barry.name}":`);
    for (const p of problems) console.log(`  ✗ ${p}`);
    identitiesToFix.push({ id: barry.id, name: barry.name, actor_id: barry.actor_id, bags });
  }

  /**
   * Two bags claiming the same action name. The first registration wins and
   * the rest are hidden from `find_actions` entirely, so the loser is
   * unreachable except as `bag:name` — and nothing anywhere says so. Whether
   * that is a stale copy to delete or two genuinely different procedures that
   * need renaming is a content decision, so this reports and never "fixes".
   */
  /**
   * Byte-identical copies are skipped: several bags intentionally ship the
   * same action via their install scripts ("also in vantage-sdks — the Grape
   * API half lives in core"), and for identical content the bare-name
   * ambiguity is harmless — either copy answers the same way. Only content
   * that actually differs is a decision someone has to make.
   *
   * Generated output is excluded from that comparison. A skill that writes
   * beside its own scripts makes two copies differ the moment anyone RUNS one
   * of them: claudebox's pod-provision.sh defaults its manifest to
   * `<skill>/tmp/k8s.pod.<name>.yml`, so provisioning from whichever bag you
   * were in grew a tmp/ there and reported the skills as divergent. The
   * shipped skills were identical every time.
   *
   * Fixed here rather than in the script: pod-provision.sh is owned by
   * vantage-sh/skills and `./install` re-copies it with `cp -R`, so a local
   * edit is reverted on the next install — and `cp -R` into an existing
   * directory leaves a stray tmp/ in place, which is why it kept returning.
   */
  function actionDirsIdentical(a: string, b: string): boolean {
    try {
      const list = (dir: string) =>
        readdirSync(dir, { recursive: true, withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => join(e.parentPath ?? e.path, e.name).slice(dir.length + 1))
          .filter((rel) => !isGeneratedArtifact(rel))
          .sort();
      const filesA = list(a);
      const filesB = list(b);
      if (filesA.length !== filesB.length || filesA.some((f, i) => f !== filesB[i])) return false;
      return filesA.every((f) => readFileSync(join(a, f)).equals(readFileSync(join(b, f))));
    } catch {
      return false; // unreadable → report rather than silently suppress
    }
  }

  // Reuses the registry `allRegistryBags` already holds, rather than an
  // implicit registry reload.
  const allActions = await listAllActions(allRegistryBags);
  const shadowed = allActions.filter((a) => {
    if (!a.shadowed) return false;
    const winner = allActions.find((w) => w.name === a.name && !w.shadowed);
    return !winner || !actionDirsIdentical(a.dir, winner.dir);
  });
  if (shadowed.length > 0) {
    console.log("\nActions hidden by a same-named action in another bag (not repaired by --fix):");
    for (const action of shadowed) {
      const winner = allActions.find((a) => a.name === action.name && !a.shadowed);
      console.log(`  ✗ ${action.qualifiedName} — shadowed by ${winner?.qualifiedName ?? "another bag"} with different content`);
    }
    console.log("  Reachable only as \"bag:name\". Delete the duplicate or rename one of them.");
  }

  reportPermissions(allRegistryBags);

  /**
   * Host binaries for bags nobody has packed.
   *
   * The per-barry loop above only ever visits `barry.metadata.bags`, so a
   * registered bag that no barry packs is never examined at all — and its
   * services and jobs run from the service management regardless of whether any barry packs
   * it. The metrics bag is exactly that shape: five scheduled jobs, packed by
   * nobody, and a broken dependency in it was invisible here while `bag show`
   * reported it correctly.
   *
   * Reported but not counted into problemCount, like the other registry-wide
   * checks: --fix repairs a barry's bag list, and an unreachable binary is a
   * host problem no list edit can fix.
   */
  const unpackedBinaryProblems: string[] = [];
  const packedSomewhere = new Set(owned.flatMap((b) => b.metadata.bags ?? []));
  for (const bag of allRegistryBags) {
    if (packedSomewhere.has(bag.name)) continue;
    for (const status of checkBagDependencyStates(bag, serverPath)) {
      if (status.state === "ok") continue;
      const dep = status.dependency.name;
      if (status.state === "unreachable") {
        unpackedBinaryProblems.push(
          `bag "${bag.name}" dependency "${dep}" is installed at ${status.resolvedPath} but not on ` +
            `the MCP server's PATH — run: barry setup`,
        );
      } else if (status.state === "missing") {
        unpackedBinaryProblems.push(
          `bag "${bag.name}" dependency "${dep}" executable was not found${packageInstallationSummary(status)}` +
            (status.dependency.install && status.packageInstallation?.state !== "installed" ? ` — install: ${status.dependency.install}` : ""),
        );
      } else {
        unpackedBinaryProblems.push(
          `bag "${bag.name}" dependency "${dep}" found at ${status.resolvedPath}, but the MCP ` +
            `server's PATH could not be read — reachability unverified`,
        );
      }
    }
  }
  if (unpackedBinaryProblems.length > 0) {
    console.log("\nHost binaries for bags no barry packs (not repaired by --fix):");
    for (const p of unpackedBinaryProblems) console.log(`  ✗ ${p}`);
    console.log("  These bags' services and jobs still run — a missing binary breaks them silently.");
  }

  /**
   * Service descriptions that do not say what the service does.
   *
   * `description` was a comment nobody read until `service status` began
   * printing it under every service; it is now the line that tells an operator
   * what a thing IS. Reported registry-wide rather than per-barry, because a
   * bag three identities enable would otherwise be reported three times for
   * the same sentence.
   *
   * Not counted into problemCount and not repaired by --fix: nothing is
   * broken, and a checker that blocks a machine over prose — or worse, rewrites
   * someone's words — would be a bigger problem than the one it solves.
   */
  const weakDescriptions = findWeakDescriptions(
    allRegistryBags
      .filter((b) => b.services.length > 0)
      .map((b) => ({
        name: b.name,
        services: b.services.map((s) => ({ name: s.name, description: s.description })),
      })),
  );
  if (weakDescriptions.length > 0) {
    console.log("\nService descriptions that name the thing but not its purpose (not repaired by --fix):");
    for (const w of weakDescriptions) console.log(`  ~ ${w.item}: ${w.reason}`);
    console.log("  `barry devops service status` shows this line under the service name.");
  }

  const manifestProblems = await reportBagManifestProblems(Boolean(options.fix));
  problemCount += manifestProblems;

  const allBags = manifestProblems > 0 && options.fix ? await loadAllBags() : allRegistryBags;

  // A bag whose manifest fails validation loads as a husk: no tools, no
  // bounds, indistinguishable from a bag that declares none. The loader only
  // warns, into whichever process loaded it -- for a service that is a log
  // nobody reads -- so this is where it becomes a counted problem.
  const invalidManifests = new Map([...getInvalidManifests()]);
  if (invalidManifests.size > 0) {
    problemCount += invalidManifests.size;
    console.log("\nInvalid bag manifests (these bags contribute no tools or bounds):");
    for (const [bag, reason] of invalidManifests) console.log(`  ✗ ${bag}: ${reason}`);
  }

  // Same shape of silent degrade, one step later: the manifest is fine but
  // the tool code would not build or import, so the bag serves no tools.
  const toolsUnavailable = allBags.filter((bag) => bag.toolsError);
  if (toolsUnavailable.length > 0) {
    problemCount += toolsUnavailable.length;
    console.log("\nBags whose tools failed to load (no tools served; namespaces they provide may be listed as orphaned above):");
    for (const bag of toolsUnavailable) console.log(`  ✗ ${bag.name}: ${bag.toolsError}`);
  }

  /**
   * MCP server ownership: one bag owns each server key, one key per upstream.
   * Key conflicts are counted — the pool's merge is first-wins, so a loser's
   * config silently vanishes. Endpoint duplicates are report-only (duplicate
   * connections, namespace drift) since the remediation is a manifest edit;
   * --fix never rewrites bag.yaml.
   */
  const declaredServers = collectDeclaredMcpServers(allRegistryBags);
  const serverKeyConflicts = findServerKeyConflicts(declaredServers);
  const endpointDuplicates = findEndpointDuplicates(declaredServers);
  if (serverKeyConflicts.length > 0 || endpointDuplicates.length > 0) {
    problemCount += serverKeyConflicts.length;
    console.log("\nMCP server ownership:");
    for (const conflict of serverKeyConflicts) console.log(`  ✗ ${conflict.message}`);
    for (const dupe of endpointDuplicates) console.log(`  ✗ ${dupe.message}`);
    console.log(
      "  One bag owns each server. Consumers compose the owner via `bags:` — never re-declare it.",
    );
  }

  // Snapshot drift: the config store is authoritative, but sync readers (CLI
  // groups, completion, hook dispatch) only ever see the generated snapshot.
  // A missing or diverged snapshot means those readers are serving a registry
  // that no longer matches the store — the exact failure this check exists to
  // name, since it is otherwise invisible until a bag "disappears".
  const snapshotDrift = await findSnapshotDrift();
  if (snapshotDrift.length > 0) {
    problemCount += snapshotDrift.length;
    console.log("\nRegistry snapshot:");
    for (const d of snapshotDrift) console.log(`  ✗ ${d}`);
  }

  // OAuth token health: HTTP-transport MCP servers silently lose connectivity
  // when their access token expires and the refresh token is dead. The session
  // comes up short on tools with no error anywhere except the MCP log. Checked
  // after bags load so the URL list is authoritative.
  // Reuses the list loaded for the port/hostname checks above rather than
  // loading a second time: loadAllBags reads every manifest off disk.
  const oauthHealth = await checkOAuthHealth(allBags, !!options.fix);
  // "missing" is report-only: an HTTP server with no cached tokens may simply
  // not require OAuth (it connects anonymously — e.g. public docs servers).
  // Only a token that existed and went bad is a definite problem.
  const oauthProblems = oauthHealth.filter((r) => r.status === "expired" || r.status === "refresh_failed");
  const oauthMissing = oauthHealth.filter((r) => r.status === "missing");
  const oauthRefreshed = oauthHealth.filter((r) => r.status === "refreshed");

  if (oauthRefreshed.length > 0) {
    console.log("\nOAuth tokens refreshed:");
    for (const r of oauthRefreshed) console.log(`  ✓ ${r.server} (${r.bag})`);
  }

  if (oauthProblems.length > 0) {
    problemCount += oauthProblems.length;
    console.log("\nOAuth MCP servers:");
    for (const r of oauthProblems) {
      const hint = r.status === "refresh_failed"
        ? "refresh failed — re-auth: barry bag auth " + r.server
        : "token expired — re-run with --fix or: barry bag auth " + r.server;
      console.log(`  ✗ ${r.server} (${r.bag}): ${hint}`);
    }
  }

  if (oauthMissing.length > 0) {
    console.log("\nHTTP MCP servers with no cached OAuth tokens (may not need them):");
    for (const r of oauthMissing) {
      console.log(`  · ${r.server} (${r.bag}) — if its tools fail, run: barry bag auth ${r.server}`);
    }
  }

  // Service checks: the service management tracks every service's state. When it is
  // available, check every declared service in its actual domain.
  if (managedServices === null) {
    console.log("\nService management unavailable — service check skipped. Prepare with: barry service add <name>");
  } else {
    const serviceProblems: string[] = [];
    for (const bag of allRegistryBags) {
      if (bag.services.length === 0) continue;
      const source = registry[bag.name];
      if (source && resolveBagAccess(source) === "disabled") continue;

      for (const svc of bag.services) {

        const key = `${bag.name}.${svc.name}`;
        const status = managedServiceByKey.get(key);

        if (!status) {
          serviceProblems.push(`service "${key}" is not known to service management`);
        } else if (status.state === "conflict") {
          serviceProblems.push(`service "${key}" has a port conflict — held by ${status.conflict}`);
        } else if (status.problem) {
          serviceProblems.push(`service "${key}": ${status.problem}`);
        } else if (status.loopbackOnly === false) {
          serviceProblems.push(`service "${key}" is bound to a non-loopback address`);
        } else if (status.state === "backoff") {
          serviceProblems.push(`service "${key}" is in backoff — check its logs with: barry service logs ${key}`);
        }
      }
    }

    if (serviceProblems.length > 0) {
      problemCount += serviceProblems.length;
      console.log("\nService problems (from service management):");
      for (const p of serviceProblems) console.log(`  ✗ ${p}`);
      console.log("  Run `barry service status` for details, or `barry up` to restart the service management.");
    }
  }

  if (problemCount === 0) {
    const healthyOAuth = oauthHealth.filter((r) => r.status === "ok" || r.status === "refreshed");
    const msg = healthyOAuth.length > 0
      ? `All identities healthy — bags registered. ${healthyOAuth.length} OAuth token${healthyOAuth.length === 1 ? "" : "s"} valid.`
      : "All identities healthy — bags registered.";
    console.log(msg);
    return;
  }

  // Unconditional, not gated on `snapshotDrift.length > 0`. The gate made the
  // repair only as good as the predicate that triggered it, and when that
  // predicate compared names only it withheld the rebuild from exactly the
  // drift it could not see: 23 entries pointing at directories that no longer
  // existed, with `--fix` declining to act because every name matched. The
  // drift predicate is a REPORTING aid; the rebuild is cheap, idempotent, and
  // derived wholly from the authoritative table, so there is no state in which
  // withholding it is the better outcome. Rebuilding always means a repair
  // that cannot be missed by a blind spot in a check.
  if (options.fix) {
    const written = await writeRegistrySnapshot();
    console.log(`\nRebuilt registry snapshot: ${written}`);
  }

  if (!options.fix) {
    console.log(`\n${problemCount} problem${problemCount === 1 ? "" : "s"} found. Re-run with --fix to repair.`);
    process.exitCode = 1;
    return;
  }

  for (const barry of identitiesToFix) {
    const result = await resolveBags(barry.bags);
    printBagWarnings(result.warnings);
    try {
      await Barry.identity(barry.name).update({ bags: result.bags });
    } catch (error) {
      // One identity the operation refuses (one with no identity.yaml, say)
      // must not stop the others' repair.
      if (!isBarryError(error)) throw error;
      console.log(`\nCould not repair barry "${barry.name}": ${error.message}${error.hint ? `\n  ${error.hint}` : ""}`);
      process.exitCode = 1;
      continue;
    }
    // Its warnings are the resolution's, printed above.
    console.log(`\nRepaired barry "${barry.name}": ${result.bags.join(", ")}`);
  }

  // Tell the service management about the repaired bags: it starts what was added and
  // stops what was removed without a setup script.
  const reconciled = await reconcileServices();
  if (reconciled) {
    const changes: string[] = [];
    if (reconciled.started.length) changes.push(`started ${reconciled.started.join(", ")}`);
    if (reconciled.stopped.length) changes.push(`stopped ${reconciled.stopped.join(", ")}`);
    if (changes.length) console.log(`  service management: ${changes.join("; ")}`);
  } else {
    console.log("  service registration unavailable — retry `barry service add <name>` after preparation");
  }
}

// ────────────────────────────────────────────────────────────────────────────
// barry bag infra — terraform operations on a bag's declared infrastructure
// ────────────────────────────────────────────────────────────────────────────

export async function bagInfraCommand(
  name: string,
  action: string,
  options: { autoApprove?: boolean; var?: string[] },
): Promise<void> {
  const source = getBagSource(name);
  if (!source) {
    console.error(`Bag '${name}' is not registered.`);
    process.exitCode = 1;
    return;
  }
  if (source.type !== "local") {
    console.error(`Bag '${name}' is remote — infra commands run against local bags only.`);
    process.exitCode = 1;
    return;
  }

  const bag = await Promise.resolve(loadBag(name));
  if (!bag?.manifest?.infra) {
    console.error(`Bag '${name}' declares no infra: block.`);
    process.exitCode = 1;
    return;
  }

  const infra = bag.manifest.infra;
  if (infra.provider !== "terraform") {
    console.error(`Unsupported infra provider: ${infra.provider}`);
    process.exitCode = 1;
    return;
  }

  const validActions = ["init", "plan", "apply", "destroy", "output", "validate"];
  if (!validActions.includes(action)) {
    console.error(`Unknown action '${action}'. Valid: ${validActions.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const bagDir = resolve(source.path.replace(/^~/, process.env.HOME ?? ""));
  const infraDir = resolve(bagDir, infra.root);
  if (!infraDir.startsWith(bagDir + "/")) {
    console.error(`Infra root escapes the bag directory: ${infra.root}`);
    process.exitCode = 1;
    return;
  }
  if (!existsSync(infraDir)) {
    console.error(`Infra directory not found: ${infraDir}`);
    process.exitCode = 1;
    return;
  }

  const tfFiles = readdirSync(infraDir).filter((f) => f.endsWith(".tf"));
  if (tfFiles.length === 0) {
    console.error(`No .tf files found in ${infraDir}`);
    process.exitCode = 1;
    return;
  }

  const which = spawnSync("which", ["terraform"], { encoding: "utf8" });
  if (which.status !== 0) {
    console.error("terraform not found on PATH. Install: https://developer.hashicorp.com/terraform/install");
    process.exitCode = 1;
    return;
  }

  // State and the bag's rendered variables are instance data, kept in the
  // bag's data directory: never in the checkout, where a re-clone would lose
  // them and a commit could leak them.
  const dataDir = bagDataDir(name);
  const args: string[] = [action];
  if (action === "init") args.push(`-backend-config=path=${join(dataDir, "terraform.tfstate")}`);
  if (action === "apply" && options.autoApprove) args.push("-auto-approve");
  if (action === "destroy" && options.autoApprove) args.push("-auto-approve");
  if (["plan", "apply", "destroy"].includes(action)) {
    for (const file of readdirSync(dataDir).filter((f) => f.endsWith(".tfvars.json")).sort()) {
      args.push(`-var-file=${join(dataDir, file)}`);
    }
  }

  for (const v of options.var ?? []) {
    args.push("-var", v);
  }

  // Each declared variable comes from the instance env, under its name
  // upper-cased: `cloudflare_tf_token` is CLOUDFLARE_TF_TOKEN. Read by name,
  // never by loading the env file into this process.
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  const missing: string[] = [];
  for (const varName of infra.variables ?? []) {
    const envKey = `TF_VAR_${varName}`;
    if (env[envKey]) continue;
    const val = instanceEnvValue(varName.toUpperCase());
    if (val) env[envKey] = val;
    else missing.push(varName.toUpperCase());
  }
  if (missing.length > 0 && action !== "init" && action !== "validate") {
    console.warn(`[${name}] not in the instance env: ${missing.join(", ")} (set with \`barry env set\`)`);
  }

  console.log(`[${name}] terraform ${args.join(" ")} (${infraDir})`);
  const result = spawnSync("terraform", args, {
    cwd: infraDir,
    stdio: "inherit",
    env,
  });
  if (result.status !== 0) {
    process.exitCode = 1;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Bag lifecycle: new → install → pack → unpack
//
// The four stages are deliberately separate commands rather than one flow:
//   new      author a bag skeleton on disk
//   install  make an existing bag USABLE — deps installed, built, registered
//   pack     mount an installed bag onto a barry
//   unpack   unmount it again, leaving the files alone
//
// `pack` fails early on an uninstalled bag instead of half-wiring it: a bag
// whose deps are missing or whose tools were never built registers fine and
// then contributes nothing, which surfaces much later as "my tools vanished".
// ────────────────────────────────────────────────────────────────────────────

/** Detect what kind of thing `target` is, the same four ways `bag add` did. */
// Reject bare repository URLs as MCP endpoints so installation cannot overwrite a valid local registration.
// Rationale: docs/decisions/0009-runtime-and-fixture-invariants.md#note-002
const GIT_HOSTS = new Set(["github.com", "www.github.com", "gitlab.com", "www.gitlab.com", "bitbucket.org", "codeberg.org", "git.sr.ht"]);

/**
 * Whether a URL is a repository rather than something that could serve MCP.
 *
 * Deliberately narrow. A git host can also host a real MCP endpoint under a
 * path (Pages, a raw file, an API route), so only the bare `owner/name` shape
 * -- with an optional `.git` suffix -- is refused. Two path segments and
 * nothing else is a repository and cannot be anything else.
 */
export function looksLikeGitRepoUrl(target: string): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (!GIT_HOSTS.has(url.hostname.toLowerCase())) return false;
  if (url.search || url.hash) return false;
  const segments = url.pathname.split("/").filter(Boolean);
  return segments.length === 2;
}

function classifyTarget(target: string): BagSource {
  if (target.startsWith("http://") || target.startsWith("https://")) {
    // A repository URL is a bag to fetch, never an MCP endpoint. The
    // predicate is unchanged and so is the thing it protects: registering one
    // of these as a REMOTE source replaced a working local bag with one that
    // serves no tools, and still would. The difference is that the right
    // answer is now available — clone it and register the checkout as local.
    if (looksLikeGitRepoUrl(target)) {
      const name = new URL(target).pathname.split("/").filter(Boolean)[1].replace(/\.git$/, "");
      return cloneToLocalSource(name, { repo: target });
    }
    return { type: "remote", url: target };
  }
  if (target.startsWith("@") || (!target.includes("/") && !target.includes(".") && !existsSync(resolve(target)))) {
    const resolved = resolveNpmBag(target);
    if (!resolved) {
      throw new CliError(`Could not resolve npm package "${target}". Is it installed? Try: pnpm add ${target}`, 1);
    }
    if (!existsSync(join(resolved, "bag.yaml"))) {
      throw new CliError(`Package "${target}" resolved to ${resolved} but contains no bag.yaml`, 1);
    }
    console.log(`Resolved ${target} → ${resolved}`);
    return { type: "local", path: resolved, npm: target };
  }
  const resolved = resolve(target);
  if (!existsSync(resolved)) {
    throw new CliError(`Path does not exist: ${resolved}`, 1);
  }
  return { type: "local", path: resolved };
}

/**
 * `barry install <target>` — make a bag usable and register it.
 *
 * Accepts a local directory, an npm specifier, or a remote MCP URL. It does NOT
 * clone: fetching the code is git's job, so the flow is
 * `git clone … && barry install ./thing`. That keeps the code wherever the user
 * wants it rather than burying it inside an identity directory.
 *
 * For local bags it installs npm dependencies and builds, because a bag that is
 * registered but unbuilt serves zero tools — silently. npm and remote bags skip
 * both: there is nothing local to install or build.
 */
/**
 * Fetch a bag by repo and describe it as the local checkout it now is.
 *
 * A cloned bag is local in every way that matters — it loads, builds and
 * contributes tools through the same path as one you cloned by hand. `git` only
 * records where it came from, the way `npm` does for a package-resolved bag.
 */
function cloneToLocalSource(name: string, source: BagChildSource): BagSource {
  let fetched;
  try {
    fetched = fetchBagRepo(name, source);
  } catch (err) {
    if (isCliError(err)) throw err;
    if (err instanceof BagFetchError) {
      throw new CliError(err.message, 1);
    }
    throw err;
  }
  console.log(`  fetch ……… ${name} ${fetched.status} at ${shortRev(fetched.rev)} → ${tildePath(fetched.path)}`);
  return {
    type: "local",
    path: fetched.path,
    git: {
      repo: fetched.repo,
      ...(fetched.rev ? { rev: fetched.rev } : {}),
      ...(fetched.ref ? { ref: fetched.ref } : {}),
    },
  };
}

function shortRev(rev: string): string {
  return rev ? rev.slice(0, 8) : "unknown";
}

function tildePath(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/**
 * Install the sub-bags a manifest declares a source for, depth-first.
 *
 * Only entries under `bags:` that actually name a source are fetched. A bare
 * name stays what it always was — best-effort widening, resolved from the
 * registry, skipped with a warning by `barry pack` if it is not there. An
 * entry naming a repo is a different claim: the child exists, at that URL. So
 * a failure fetching, parsing or registering one FAILS THIS INSTALL rather
 * than leaving a parent that registers cleanly and hands out no tools.
 *
 * `visited` is keyed by resolved source, not by name, so a diamond (two
 * parents naming one child) installs it once and a cycle terminates.
 */
async function installDeclaredChildren(
  parentName: string,
  parentDir: string,
  manifest: BagManifest | null,
  options: { force?: boolean },
  visited: Set<string>,
  depth = 0,
): Promise<boolean> {
  const sources = manifest?.bagSources;
  if (!sources || Object.keys(sources).length === 0) return true;

  // A child that fails to build leaves the parent composing nothing, so the
  // failure has to reach the caller rather than only process.exitCode.
  let allOk = true;

  // Deep enough to be a mistake rather than a structure. Bags compose a
  // handful of children, not a dependency graph.
  if (depth > 8) {
    throw new CliError(`Bag composition nested more than 8 deep under "${parentName}" — is there a cycle?`, 1);
  }

  for (const [childName, source] of Object.entries(sources)) {
    // Keyed by repo AND subdir, because one repo can ship several bags. Keying
    // on the URL alone made the second and later children of a monorepo look
    // already-installed, and `continue` is silent: the parent registered
    // cleanly and simply never contributed their tools.
    const key = source.repo
      ? `repo:${resolveRepoUrl(source.repo)}#${source.subdir ?? ""}`
      : `path:${resolve(parentDir, source.path ?? "")}`;
    if (visited.has(key)) continue;
    visited.add(key);

    let childDir: string;
    if (source.repo) {
      const cloned = cloneToLocalSource(childName, source);
      childDir = (cloned as { path: string }).path;
    } else {
      // A relative path is relative to the bag that declared it, so a parent
      // and its children can sit side by side in one checkout.
      childDir = resolve(parentDir, source.path ?? "");
      if (!existsSync(join(childDir, "bag.yaml"))) {
        console.error(
          `Bag "${parentName}" declares sub-bag "${childName}" at ${source.path}, ` +
            `but there is no bag.yaml at ${childDir}.`,
        );
        throw new CliError("", 1);
      }
      console.log(`  fetch ……… ${childName} local → ${tildePath(childDir)}`);
    }

    const childManifest = parseManifest(childDir);
    if (!childManifest) {
      throw new CliError(`Bag "${parentName}" declares sub-bag "${childName}", but ${childDir}/bag.yaml could not be parsed.`, 1);
    }

    const descendantsOk = await installDeclaredChildren(childName, childDir, childManifest, options, visited, depth + 1);
    const childOk = await installResolvedBag(childName, childDir, source.repo ? cloneSourceFor(childName, childDir, source) : { type: "local", path: childDir }, options);
    if (!descendantsOk || !childOk) allOk = false;
  }

  return allOk;
}

/**
 * Re-describe an already-fetched child without touching the checkout again.
 * `fetchBagRepo` is idempotent, so this reports the state on disk.
 */
function cloneSourceFor(name: string, dir: string, source: BagChildSource): BagSource {
  const rev = headOf(dir) ?? "";
  return {
    type: "local",
    path: dir,
    git: {
      repo: resolveRepoUrl(source.repo as string),
      ...(source.rev ? { rev } : {}),
      ...(source.ref ? { ref: source.ref } : {}),
    },
  };
}

// After a failed install, check whether declared dependencies actually exist before abandoning registration.
// Rationale: docs/decisions/0009-runtime-and-fixture-invariants.md#note-003
export function installBagDependencies(bagDir: string): void {
  if (!bagNeedsInstall(bagDir)) return;

  const res = spawnSync("pnpm", ["install"], { cwd: bagDir, stdio: "inherit" });
  if (res.status === 0) return;

  // Nonzero exit — did the dependencies land anyway?
  if (bagNeedsInstall(bagDir)) {
    throw new CliError(`\npnpm install failed in ${bagDir} — the bag would load with missing dependencies.`, 1);
  }

  console.warn(
    `\n  dependencies … installed, but pnpm exited ${res.status}. ` +
      `Dependencies are present, so the install continues; the bag may need ` +
      `\`cd ${tildePath(bagDir)} && pnpm approve-builds\` if a package ships a build script.`,
  );
}

/**
 * The shared tail of installing a local bag: dependencies, registry, build.
 * Used for both the target of the command and every child it pulled in, so a
 * composed child is installed exactly as thoroughly as a top-level one.
 */
async function installResolvedBag(
  name: string,
  bagDir: string,
  source: BagSource,
  options: { force?: boolean },
): Promise<boolean> {
  installBagDependencies(bagDir);

  await upsertBag(name, source);

  const { discoverBuildableBags } = await import("@barry-rocks/sdk/internal/bags");
  if (discoverBuildableBags().some((b) => b.name === name)) {
    if (!(await bagBuildCommand(name, { force: options.force }))) {
      console.error(`\nBuild failed for "${name}" — it is registered but ships no tools until this is fixed.`);
      process.exitCode = 1;
      return false;
    }
  }
  return true;
}

/**
 * `barry install <target>` — SYSTEM-level: register a bag on this machine and
 * build it. It puts the bag on no identity; that is `<identity> pack`, or
 * `<identity> install`, which runs this and then offers to pack.
 *
 * Returns the registered name, or undefined when the install did not complete.
 */
export async function bagInstallCommand(
  target: string,
  options: { as?: string; force?: boolean; quiet?: boolean } = {},
): Promise<string | undefined> {
  const source = classifyTarget(target);
  const bagDir = source.type === "local" ? source.path : null;

  // The manifest is what makes a directory a bag; refuse early rather than
  // registering something that can never load.
  let name = options.as;
  let manifest: BagManifest | null = null;
  if (bagDir) {
    const manifestPath = join(bagDir, "bag.yaml");
    if (!existsSync(manifestPath)) {
      throw new CliError(`No bag.yaml in ${bagDir} — this is not a bag.`, 1);
    }
    manifest = parseManifest(bagDir);
    if (!manifest) {
      throw new CliError(`Could not parse ${manifestPath}.`, 1);
    }
    name = name ?? manifest.name;
  } else {
    name = name ?? basename(target).replace(/\.git$/, "");
  }

  if (!name) {
    throw new CliError("Could not determine a bag name — pass --as <name>.", 1);
  }
  console.log(`Installing "${name}" from ${bagDir ?? target}`);

  // Children first: a parent that registers before its declared children are
  // in place is exactly the half-installed state this replaces — registered,
  // reported as success, contributing none of the tools it composes.
  let childrenOk = true;
  if (bagDir && manifest) {
    childrenOk = await installDeclaredChildren(name, bagDir, manifest, options, new Set([`path:${bagDir}`]));
  }

  if (bagDir) {
    if (bagNeedsInstall(bagDir)) {
      console.log("  dependencies …");
      installBagDependencies(bagDir);
    } else {
      console.log("  dependencies … none needed");
    }
  }

  await upsertBag(name, source);
  console.log(`  registry ……… "${name}" registered`);

  // Own build and children are separate failure sources; assigning rather than
  // combining them would let a successful own-build mask a failed child.
  let ownBuildOk = true;
  if (bagDir) {
    const { discoverBuildableBags } = await import("@barry-rocks/sdk/internal/bags");
    if (discoverBuildableBags().some((b) => b.name === name)) {
      console.log("  build ………");
      ownBuildOk = await bagBuildCommand(name, { force: options.force });
    }
  }
  const built = ownBuildOk && childrenOk;

  // "Installed." over a failed build is the half-installed state this split
  // exists to prevent: registered, reported as success, contributing no tools.
  if (!built) {
    console.error(
      !ownBuildOk
        ? `\nRegistered "${name}", but its build FAILED — it will contribute no tools until the errors above are fixed.`
        : `\nRegistered "${name}", but a bag it composes FAILED to build — it will contribute those tools only once the errors above are fixed.`,
    );
    process.exitCode = 1;
    return undefined;
  }

  // Tell the service management about the new bag: it starts the bag's services
  // without a setup script. Unconditional because the service management is idempotent.
  const reconciled = await reconcileServices();
  if (reconciled) {
    const changes: string[] = [];
    if (reconciled.started.length) changes.push(`started ${reconciled.started.join(", ")}`);
    if (reconciled.stopped.length) changes.push(`stopped ${reconciled.stopped.join(", ")}`);
    if (changes.length) console.log(`  service management: ${changes.join("; ")}`);
  } else {
    console.log("  service registration unavailable — retry `barry service add <name>` after preparation");
  }

  // The engine builds its bag pool once at boot and never reloads it, so a bag
  // installed after boot is invisible to every running session until the engine
  // restarts. `access` and `auth` already restart for the same reason; install
  // did not, and the gap was masked by sessions reaching un-granted bags
  // directly. Closing that bypass makes this restart load-bearing.
  if (await restartManagedService(MCP_SERVER_KEY)) {
    console.log("  engine ……… restarted, so new sessions see this bag's tools");
  } else {
    console.log(
      "  engine ……… NOT restarted. Run `barry service restart mcp.server`, " +
        "or this bag's tools stay invisible to sessions.",
    );
  }

  // `barry pack` does not exist: packing is per identity, so the hint names the
  // identity command that does it.
  if (!options.quiet) console.log(`\nInstalled. Pack it onto an identity with: <identity> pack ${name}`);
  return name;
}

/**
 * Why a bag is not ready to be packed, or null when it is.
 *
 * "Installed" means: registered, present on disk, dependencies resolved, and
 * built if it ships tools. Anything less registers cleanly and then contributes
 * nothing to a session.
 */
async function installBlockers(name: string, targetRow?: Awaited<ReturnType<typeof getBag>>): Promise<string[]> {
  const row = targetRow !== undefined ? targetRow : await getBag(name);
  if (!row) {
    return [`"${name}" is not registered — run: barry install <path|npm|url>`];
  }
  const source = row.source;

  // A disabled bag is filtered out of discoverBuildableBags, so the build check
  // below short-circuits and the gate passes — but loadBag returns null for it,
  // so packing yields a bag with zero tools. Check access explicitly.
  if (resolveBagAccess(source as Parameters<typeof resolveBagAccess>[0]) === "disabled") {
    return [`"${name}" is disabled in the registry (barry bag access ${name} enabled)`];
  }

  if (source.type !== "local") return [];

  // Resolve builtin registration paths relative to their owning directory rather than the caller’s CWD.
  // Rationale: docs/decisions/0009-runtime-and-fixture-invariants.md#note-004
  const rawPath = String(source.path ?? "").replace(/^~/, process.env.HOME ?? "");
  const path = resolveBuiltinPath(rawPath);
  const problems: string[] = [];
  if (!existsSync(path)) {
    problems.push(`"${name}" points at ${source.path} (resolved: ${path}), which does not exist`);
    return problems;
  }
  if (bagNeedsInstall(path)) {
    problems.push(`"${name}" declares npm dependencies but has no node_modules (cd ${path} && pnpm install)`);
  }
  const { discoverBuildableBags, getBuiltBagEntry } = await import("@barry-rocks/sdk/internal/bags");
  if (discoverBuildableBags().some((b) => b.name === name) && !getBuiltBagEntry(name, path)) {
    problems.push(`"${name}" ships tools but has not been built (barry bag build ${name})`);
  }
  return problems;
}

/** Ask a y/N question on the terminal. Anything but y/yes is no. */
export async function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === "y" || trimmed === "yes");
    });
  });
}

/**
 * An identity's packed bags are defined in its identity.yaml; the DB row only
 * caches the file. A DB-only identity has no file to define them in, so pack
 * and unpack refuse it rather than writing membership nothing declares.
 */
async function requireIdentityFile(identityName: string): Promise<string> {
  const dir = identityRecords.directory({ name: identityName });
  if (!dir) {
    const message = `"${identityName}" has no identity.yaml. An identity's packed bags are defined there, so only an identity with one can pack or unpack.`;
    throw new CliError(message, 1);
  }
  return dir;
}

/**
 * Create and migrate the identity-owned stores a packed bag declares, so a
 * broken migration fails the pack instead of the bag's first tool call. A
 * store the identity points elsewhere (`store: {filepath | url}` on its
 * identity.yaml entry) lives where it says and is left alone. Idempotent:
 * opening an existing store only applies pending migrations.
 */
async function provisionIdentityStores(
  bagName: string,
  source: { type?: string; path?: string },
  identityName: string,
): Promise<string[]> {
  // From the registered source rather than the registry snapshot: pack already
  // holds the row, and a stale snapshot must not decide which stores exist.
  if (source.type !== "local" || !source.path) return [];
  // Builtin rows store paths relative to the builtin dir; resolved as
  // installBlockers does.
  const path = resolveBuiltinPath(source.path.replace(/^~/, homedir()));
  const manifest = parseManifest(path);
  const declared = Object.entries(manifest?.stores ?? {}).filter(([, d]) => d.owned_by === "identity");
  if (!manifest || declared.length === 0) return [];
  const bag = { name: bagName, source: { type: "local", path }, manifest };
  const identity = await requireIdentityByName(identityName);
  const overrides = identity.metadata.bag_configs?.[bagName]?.stores ?? {};
  const { NodeRegistry } = await import("@barry-rocks/sdk/internal/nodes");
  const { StoreRegistry } = await import("@barry-rocks/sdk/stores");
  const { activeStoreRoot } = await import("@barry-rocks/sdk/internal/stores");
  const { loadDeclaredStores } = await import("@barry-rocks/sdk/internal/stores");
  const nodes = new NodeRegistry();
  const stores = new StoreRegistry(nodes.id, activeStoreRoot());
  await loadDeclaredStores(stores, [bag]);
  const identityKey = nodes.identityId(identity.id);
  const provisioned: string[] = [];
  for (const [store] of declared) {
    if (Object.hasOwn(overrides, store)) continue;
    (await stores.open({ node: nodes.id, identity: identityKey, bag: bagName, store })).close();
    provisioned.push(store);
  }
  return provisioned;
}

/**
 * `<identity> pack <bag>` — put an INSTALLED bag on this identity: add it to
 * identity.yaml and create the identity-owned stores it declares.
 *
 * Installing is system-level and separate (`barry install`, or
 * `<identity> install`, which offers to pack afterwards). Pack used to offer
 * an install itself, which blurred the two: a bag looked "added" to an
 * identity while actually being registered for the whole machine.
 */
export async function bagPackCommand(
  name: string,
  options: { name?: string; optional?: boolean } = {},
): Promise<void> {
  const identityName = await resolveOptionBarry({ name: options.name });
  const row = await getBag(name);
  if (!row) {
    const message = `Bag '${name}' is not installed. Install it with: ${identityName} install <path-or-url> (installs it, then offers to pack it).`;
    throw new CliError(message, 1);
  }

  const blockers = await installBlockers(name, row);
  if (blockers.length > 0) {
    console.error(`Cannot pack "${name}" — it is not installed:`);
    for (const b of blockers) throw new CliError(`  ✗ ${b}`, 1);
    throw new Error(`Cannot pack "${name}" — it is not installed`);
  }
  await requireIdentityFile(identityName);
  await addBagToIdentity(name, identityName, { optional: options.optional });
  const provisioned = await provisionIdentityStores(name, row.source, identityName);
  if (provisioned.length > 0) console.log(`  stores: ${provisioned.map((store) => `${name}/${store}`).join(", ")} ready for "${identityName}"`);
}

/**
 * `<identity> install <target>` — the system-level install, then a y/N
 * question: pack it onto this identity too? `--yes` packs without asking.
 * Without a terminal to ask on it does not pack, and says how to.
 */
export async function identityInstallCommand(
  target: string,
  options: {
    as?: string;
    force?: boolean;
    yes?: boolean;
    prompt?: (question: string) => Promise<boolean>;
    install?: typeof bagInstallCommand;
  } = {},
): Promise<void> {
  const install = options.install ?? bagInstallCommand;
  const name = await install(target, { as: options.as, force: options.force, quiet: true });
  if (!name) return;
  const identityName = await resolveOptionBarry({});
  const ask = options.prompt ?? (process.stdin.isTTY ? promptYesNo : undefined);
  const pack = options.yes || (ask ? await ask(`\nPack "${name}" onto ${identityName}? [y/N] `) : false);
  if (!pack) {
    console.log(`\nInstalled, not packed. Pack it with: ${identityName} pack ${name}`);
    return;
  }
  await bagPackCommand(name, { name: identityName });
}

export const packBag = bagPackCommand;

/**
 * `<identity> unpack <bag>` — take a bag off an identity.
 *
 * Never touches the files on disk: unpacking is the inverse of packing, not of
 * installing. It also declines to unregister a bag another barry still uses,
 * since that would silently break the other one.
 */
export async function bagUnpackCommand(
  name: string,
  options: { name?: string; unregister?: boolean } = {},
): Promise<void> {
  const identityName = await resolveOptionBarry({ name: options.name });
  await requireIdentityFile(identityName);
  const identity = await requireIdentityByName(identityName);
  const packed = new Set(await expandCompositionFromSnapshot(identity.metadata.bags ?? []));
  const requiredBy = packedBagsRequiring(name, (await loadAllBags()).filter((bag) => packed.has(bag.name)));
  if (requiredBy.length > 0) {
    console.error(
      `Refusing to unpack "${name}": ${requiredBy.join(", ")} ${requiredBy.length === 1 ? "requires" : "require"} it. ` +
        `Unpack ${requiredBy.length === 1 ? "that bag" : "those bags"} first.`,
    );
    throw new CliError("", 1);
  }
  await removeBagFromIdentity(name, identityName);

  if (!options.unregister) return;

  // A bag reachable only as someone else's sub-bag is still in use, so compare
  // against each barry's COMPOSED set rather than its stored list.
  const others: string[] = [];
  for (const { record: barry } of await identityRecords.list()) {
    if (barry.name === identityName) continue;
    const composed = await expandCompositionFromSnapshot(barry.metadata.bags ?? []);
    if (composed.includes(name)) others.push(barry.name);
  }
  if (others.length > 0) {
    console.log(
      `\nStill registered: "${name}" is packed on ${others.join(", ")}.\n` +
        `Unregistering would break ${others.length === 1 ? "that barry" : "those barrys"}, so the registry entry is kept.`,
    );
    return;
  }

  // Registry-wide check, independent of what any barry currently packs: a
  // parent declaring this bag would be left with a dangling `bags:` entry even
  // if nobody has that parent packed yet.
  const declaredBy = (await loadAllBags())
    .filter((bag) => bag.name !== name && (bag.manifest?.bags ?? []).includes(name))
    .map((bag) => bag.name);
  if (declaredBy.length > 0) {
    console.log(
      `\nStill referenced: "${name}" is declared as a sub-bag by ${declaredBy.join(", ")}.\n` +
        `Unregistering would leave ${declaredBy.length === 1 ? "that bag" : "those bags"} with a dangling reference, so the registry entry is kept.`,
    );
    return;
  }

  await deleteBag(name);
  // The service management stops services for bags no longer in the registry.
  const reconciled = await reconcileServices();
  if (reconciled?.stopped.length) {
    console.log(`  service management: stopped ${reconciled.stopped.join(", ")}`);
  } else if (!reconciled) {
    console.log("  service cleanup incomplete — retry `barry service remove <name>`");
  }
  console.log(`Bag "${name}" unregistered. Its files are untouched.`);
}
