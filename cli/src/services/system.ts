import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, chownSync, cpSync, existsSync, lchownSync, lstatSync, mkdirSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { openInstance, type Instance, acquireLock } from "@barry-rocks/sdk/internal/services";
import { ServiceManagement, renderService, type ServiceDefinition } from "@barry-rocks/mcp-bag";
import { type JobState, type ServiceOS } from "@barry-rocks/mcp-bag";
import { waitForServices } from "@barry-rocks/mcp-bag";

import { nodeRuntime, runtimeTarball, sha256, type NodeRuntime } from "./runtime.js";
import type { ServiceSpec } from "./specs.js";

export interface SystemPaths {
  code: string;
  /** The root-owned Node the service runs, installed from `tarball`. */
  runtime: string;
  /** The pinned runtime's tarball in the owner's cache. */
  tarball: string;
  state: string;
  logs: string;
  legacy: string;
  plists: string;
}
export function systemPaths(instance: Instance, bag: string, key: string): SystemPaths {
  // Root creates and deletes these, and the bag name can come from a record the user can edit.
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(bag) || bag.includes("..")) throw new Error(`not a bag name usable in a system path: ${JSON.stringify(bag)}`);
  const base = join("/usr/local/libexec/barry", instance.id);
  const state = `/usr/local/var/barry-${bag}${process.env.BARRY_HOME ? `-${instance.id}` : ""}`;
  return {
    code: join(base, key), runtime: join(base, "runtime", nodeRuntime().name), tarball: runtimeTarball(),
    state, logs: join(state, "logs"), legacy: join(base, "legacy"), plists: "/Library/LaunchDaemons",
  };
}
export function isSystemService(definition: ServiceDefinition): boolean {
  return definition.domain === "system" || Boolean(definition.user);
}
export function legacyLabel(key: string): string {
  return `com.barry.bag.${key}`;
}
export function vaultDaemon(management: ServiceManagement): { label: string; plistPath: string } {
  const definition = management.definition("vault.api");
  const label = management.label("vault.api");
  const plistPath = join(definition.plistDirectory, `${label}.plist`);
  return existsSync(plistPath) ? { label, plistPath } : { label: legacyLabel("vault.api"), plistPath: join(definition.plistDirectory, `${legacyLabel("vault.api")}.plist`) };
}
export function systemDefinition(spec: ServiceSpec, paths: SystemPaths): ServiceDefinition {
  if (!spec.user || !spec.entry || !/\.(?:mjs|cjs|js)$/.test(spec.entry))
    throw new Error(`${spec.key}: system services need a built JavaScript entry`);
  return {
    name: spec.key, user: spec.user, domain: "system", directory: paths.code,
    plistDirectory: paths.plists, logDirectory: paths.logs,
    // Never the user's Node: whoever can replace the interpreter controls what runs as the account.
    command: [join(paths.runtime, "bin", "node"), join(paths.code, basename(spec.entry))],
    environment: {
      PATH: "/usr/bin:/bin", BARRY_SERVICE: spec.key, BARRY_BAG_DATA_DIR: paths.state,
      ...(spec.socket ? { BARRY_SERVICE_SOCKET: spec.socket } : {}),
    },
    shutdownMs: spec.shutdownMs, health: spec.health, automatic: spec.autostart === "login",
  };
}

/** Check lexical parents as well as symlink destinations, including missing install paths. */
export function assertRootProtected(path: string): void {
  if (!isAbsolute(path)) throw new Error("protected paths must be absolute");
  let existing = path;
  while (!existsSync(existing)) existing = dirname(existing);
  for (const start of [existing, realpathSync(existing)]) {
    for (let current = start; ; current = dirname(current)) {
      const stat = statSync(current);
      if (stat.uid !== 0 || (stat.mode & 0o022))
        throw new Error(`system execution path is not root-protected: ${current}`);
      // A lexical symlink's target parents matter even when the final file isn't a symlink.
      const resolved = realpathSync(current);
      if (resolved !== current) {
        for (let target = resolved; ; target = dirname(target)) {
          const info = statSync(target);
          if (info.uid !== 0 || (info.mode & 0o022)) throw new Error(`system execution path is not root-protected: ${target}`);
          if (target === dirname(target)) break;
        }
      }
      if (current === dirname(current)) break;
    }
  }
}

/** Digest installed content, independent of ownership and write bits removed at installation. */
export function codeDigest(path: string): string | null {
  if (!existsSync(path)) return null;
  const hash = createHash("sha256");
  const walk = (current: string, relative: string, ancestors: Set<string>) => {
    const resolved = realpathSync(current);
    if (ancestors.has(resolved)) throw new Error(`cyclic code symlink: ${current}`);
    const stat = statSync(current);
    hash.update(JSON.stringify([relative, stat.isDirectory() ? "directory" : "file", stat.isDirectory() ? 0 : stat.mode & 0o111]));
    if (stat.isDirectory()) {
      const next = new Set(ancestors).add(resolved);
      for (const child of readdirSync(current).sort()) walk(join(current, child), join(relative, child), next);
    } else if (stat.isFile()) hash.update(readFileSync(current));
    else throw new Error(`unsupported code file: ${current}`);
  };
  walk(path, "", new Set());
  return hash.digest("hex");
}
export interface SystemAccount { uid: number; gid: number; group: string }
export interface SystemOS {
  uid(): number;
  sudoUid(): number | undefined;
  owner(uid: number): string;
  account(name: string): SystemAccount | undefined;
  ids(): { uids: number[]; gids: number[] };
  member(owner: string, gid: number): boolean;
  exists(path: string): boolean;
  read(path: string): string;
  digest(path: string): string | null;
  /** SHA-256 of a regular file, or null when there is none. */
  fileDigest(path: string): string | null;
  protected(path: string): boolean;
  stateParent(path: string): string;
  environmentNames(plist: string): string[] | undefined;
  createAccount(name: string, id: number): void;
  addMember(owner: string, group: string): void;
  directory(path: string, uid: number, gid: number, mode: number): void;
  stage(source: string, code: string): void;
  /** Verify the tarball against `digest` and extract it into `<runtime>.staging`, root-owned and read-only. */
  stageRuntime(tarball: string, digest: string, runtime: string): void;
  /** Throw unless `node`, run as the account, loads every native module under `code`. */
  loadNativeModules(node: string, code: string, account: SystemAccount): void;
  swap(code: string): void;
  restore(code: string): void;
  saveLegacy(source: string, target: string): void;
  remove(path: string): void;
  writePlist(path: string, contents: string): void;
}
export function selectAccountId(ids: { uids: number[]; gids: number[] }): number {
  for (let id = 400; id <= 440; id++) if (!ids.uids.includes(id) && !ids.gids.includes(id)) return id;
  throw new Error("no free service uid/gid pair in 400-440");
}
export function assertAccountName(name: string): void {
  if (!/^_[a-z0-9][a-z0-9_-]*$/.test(name)) throw new Error(`invalid service account name: ${name}`);
}
export function systemOS(): SystemOS {
  const run = (file: string, args: string[]) => execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const missing = (error: unknown) => /Unknown user|no such user|no such key|eDSRecordNotFound|does not exist/i.test(String((error as { stderr?: unknown }).stderr ?? error));
  const tree = (path: string, uid: number, gid: number) => {
    const stat = lstatSync(path);
    // The runtime's own links (bin/npm) stay links; staged code was dereferenced.
    if (stat.isSymbolicLink()) { lchownSync(path, uid, gid); return; }
    chownSync(path, uid, gid);
    // The service account must be able to read even a privately built source file,
    // and nothing root-owned here may keep a set-id bit.
    chmodSync(path, stat.isDirectory() ? 0o755 : (stat.mode | 0o444) & 0o555);
    if (stat.isDirectory()) for (const entry of readdirSync(path)) tree(join(path, entry), uid, gid);
  };
  return {
    uid: () => process.getuid?.() ?? -1,
    sudoUid: () => process.env.SUDO_UID === undefined ? undefined : Number(process.env.SUDO_UID),
    owner: (uid) => run("/usr/bin/id", ["-nu", String(uid)]),
    account: (name) => {
      try { return { uid: Number(run("/usr/bin/id", ["-u", name])), gid: Number(run("/usr/bin/id", ["-g", name])), group: run("/usr/bin/id", ["-gn", name]) }; }
      catch (error) { if (missing(error)) return undefined; throw error; }
    },
    ids: () => {
      const list = (kind: string, field: string) => run("/usr/bin/dscl", [".", "-list", kind, field]).split("\n").map((line) => Number(line.trim().split(/\s+/).at(-1)));
      return { uids: list("/Users", "UniqueID"), gids: list("/Groups", "PrimaryGroupID") };
    },
    member: (owner, gid) => run("/usr/bin/id", ["-G", owner]).split(/\s+/).map(Number).includes(gid),
    stateParent: (path) => dirname(existsSync(path) ? realpathSync(path) : path),
    exists: existsSync, read: (path) => readFileSync(path, "utf8"), digest: codeDigest,
    fileDigest: (path) => {
      try { return lstatSync(path).isFile() ? sha256(readFileSync(path)) : null; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    },
    protected: (path) => { try { assertRootProtected(path); return true; } catch { return false; } },
    environmentNames: (path) => {
      try { readFileSync(path); const plist = JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", path])) as { EnvironmentVariables?: Record<string, string> }; return Object.keys(plist.EnvironmentVariables ?? {}).filter((name) => name !== "PATH"); }
      catch (error) { if (/permission|not permitted/i.test(String((error as { stderr?: unknown }).stderr ?? error))) return undefined; throw error; }
    },
    createAccount: (name, id) => {
      assertAccountName(name);
      const dscl = (args: string[]) => run("/usr/bin/dscl", [".", ...args]);
      dscl(["-create", `/Groups/${name}`]); dscl(["-create", `/Groups/${name}`, "PrimaryGroupID", String(id)]);
      dscl(["-create", `/Users/${name}`]);
      for (const [key, value] of Object.entries({ UniqueID: String(id), PrimaryGroupID: String(id), UserShell: "/usr/bin/false", NFSHomeDirectory: "/var/empty", Password: "*", RealName: `Barry ${name.slice(1)}` })) dscl(["-create", `/Users/${name}`, key, value]);
      if (Number(run("/usr/bin/id", ["-u", name])) !== id) throw new Error(`failed to verify account ${name}`);
    },
    addMember: (owner, group) => { run("/usr/sbin/dseditgroup", ["-o", "edit", "-a", owner, "-t", "user", group]); },
    directory: (path, uid, gid, mode) => {
      if (existsSync(path)) return;
      const parent = dirname(path);
      if (!existsSync(parent)) {
        // Ancestors are always root-owned; only the requested directory belongs to the account.
        const createParents = (dir: string) => { if (existsSync(dir)) return; createParents(dirname(dir)); mkdirSync(dir, { mode: 0o755 }); chownSync(dir, 0, 0); };
        createParents(parent);
      }
      mkdirSync(path, { mode }); chownSync(path, uid, gid); chmodSync(path, mode);
    },
    stage: (source, code) => {
      const staged = `${code}.staging`;
      rmSync(staged, { recursive: true, force: true });
      cpSync(source, staged, { recursive: true, dereference: true });
      tree(staged, process.getuid?.() ?? 0, process.getgid?.() ?? 0);
    },
    stageRuntime: (tarball, digest, runtime) => {
      // The tarball sits in the user's cache: extract the bytes that were verified, never reread the path.
      if (!lstatSync(tarball).isFile()) throw new Error(`${tarball} is not a file`);
      const bytes = readFileSync(tarball);
      if (sha256(bytes) !== digest) throw new Error(`${tarball} does not match the pinned SHA-256; run \`barry setup\` first`);
      const staged = `${runtime}.staging`;
      rmSync(staged, { recursive: true, force: true });
      mkdirSync(staged, { mode: 0o755 });
      // As root, tar restores the archive's owners, modes, ACLs and flags by default; take none of them.
      execFileSync("/usr/bin/tar", [
        "-xzf", "-", "--no-same-owner", "--no-same-permissions", "--no-acls", "--no-xattrs", "--no-fflags", "--no-mac-metadata",
        "--strip-components", "1", "-C", staged,
      ], { input: bytes, stdio: ["pipe", "ignore", "pipe"] });
      tree(staged, process.getuid?.() ?? 0, process.getgid?.() ?? 0);
    },
    loadNativeModules: (node, code, account) => {
      const modules: string[] = [];
      const walk = (directory: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) walk(path);
          else if (entry.isFile() && entry.name.endsWith(".node")) modules.push(path);
        }
      };
      walk(code);
      // Requiring the addon itself is what checks its ABI; a package's index may load it lazily.
      try {
        execFileSync(node, ["-e", "for (const path of process.argv.slice(1)) require(path)", ...modules], {
          cwd: code, uid: account.uid, gid: account.gid, env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "ignore", "pipe"],
        });
      } catch (error) {
        throw new Error(`${node} cannot load the native modules of ${code}: ${String((error as { stderr?: unknown }).stderr ?? error).trim()}`);
      }
    },
    swap: (code) => {
      if (existsSync(code)) { rmSync(`${code}.previous`, { recursive: true, force: true }); renameSync(code, `${code}.previous`); }
      try { renameSync(`${code}.staging`, code); }
      catch (error) { if (existsSync(`${code}.previous`)) renameSync(`${code}.previous`, code); throw error; }
    },
    restore: (code) => { rmSync(code, { recursive: true, force: true }); if (existsSync(`${code}.previous`)) renameSync(`${code}.previous`, code); },
    saveLegacy: (source, target) => { cpSync(source, target); chownSync(target, 0, 0); chmodSync(target, 0o600); },
    remove: unlinkSync,
    writePlist: (path, contents) => { const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, contents, { mode: 0o600 }); chownSync(tmp, 0, 0); renameSync(tmp, path); },
  };
}

type ActionKind = "account" | "group" | "directory" | "stage" | "stage-runtime" | "load" | "save" | "stop-legacy" | "swap" | "swap-runtime" | "add" | "enable" | "start" | "restart" | "health" | "remove-legacy";
export interface SystemAction { kind: ActionKind; description: string; path?: string; uid?: number; gid?: number; mode?: number }
export interface SystemObservation {
  definition: ServiceDefinition;
  spec: ServiceSpec;
  paths: SystemPaths;
  account: SystemAccount;
  accountMissing: boolean;
  member: boolean;
  source: string;
  codeChanged: boolean;
  runtime: NodeRuntime;
  /** The pinned runtime is not installed; its cached tarball was verified. */
  runtimeMissing: boolean;
  plistChanged: boolean;
  label: string;
  previousPlist?: string;
  registered: boolean;
  enabled: boolean;
  job: JobState;
  legacyJob: JobState;
  legacyPlist: string;
  legacyExists: boolean;
  legacyNames: string[] | undefined;
  missing: string[];
  owner: string;
}
export function observeSystem(management: ServiceManagement, spec: ServiceSpec, os: SystemOS, serviceOS: ServiceOS, paths = systemPaths(management.instance, spec.bag, spec.key)): SystemObservation {
  const definition = management.definition(spec.key);
  assertAccountName(spec.user ?? "");
  const expected = systemDefinition(spec, paths);
  if (JSON.stringify(definition) !== JSON.stringify(expected)) {
    // Property order in hand-written records is irrelevant; every value and key must still match.
    const sorted = (value: ServiceDefinition) => JSON.stringify(Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, k === "environment" ? Object.fromEntries(Object.entries(v).sort()) : v])));
    if (sorted(definition) !== sorted(expected)) throw new Error(`${spec.key}: run \`barry setup\` first (invalid system definition)`);
  }
  if (!os.exists(spec.entry!)) throw new Error(`${spec.key}: build it first with \`pnpm --filter @barry-rocks/${spec.bag}-bag build\``);
  const runtime = nodeRuntime();
  const runtimeMissing = !os.exists(join(paths.runtime, "bin", "node"));
  if (runtimeMissing) {
    // No network here: the owner's `barry setup` downloaded it, and only the pinned digest makes it trusted.
    const digest = os.fileDigest(paths.tarball);
    if (digest === null) throw new Error(`${spec.key}: run \`barry setup\` first (node v${runtime.version} is not downloaded to ${paths.tarball})`);
    if (digest !== runtime.sha256) throw new Error(`${spec.key}: run \`barry setup\` first (${paths.tarball} does not match the pinned SHA-256)`);
  }
  for (const parent of [paths.code, paths.runtime, dirname(paths.state), os.stateParent(paths.state), paths.plists, paths.legacy])
    if (!os.protected(parent)) throw new Error(`system execution path is not root-protected: ${parent}`);
  const existing = os.account(spec.user!);
  if (existing && existing.uid >= 500) throw new Error(`${spec.user} is a login account (uid ${existing.uid})`);
  const id = existing ? existing.uid : selectAccountId(os.ids());
  const account = existing ?? { uid: id, gid: id, group: spec.user! };
  const owner = os.owner(management.instance.uid!);
  const label = management.label(spec.key);
  const legacyPlist = join(paths.plists, `${legacyLabel(spec.key)}.plist`);
  const legacyExists = os.exists(legacyPlist);
  const choice = management.choice(spec.key);
  const plist = join(paths.plists, `${label}.plist`);
  let previousPlist: string | undefined;
  if (os.exists(plist)) {
    try { previousPlist = os.read(plist); }
    catch (error) { if (!["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  }
  const job = serviceOS.inspect("system", label), legacyJob = serviceOS.inspect("system", legacyLabel(spec.key));
  if (legacyJob.loaded && !legacyExists) throw new Error(`${legacyLabel(spec.key)} is loaded without its plist; cannot restore it on failure`);
  if (job.loaded && previousPlist === undefined && os.uid() === 0) throw new Error(`${label} is loaded without a readable plist; cannot restore it on failure`);
  return {
    definition, spec, paths, account, owner, accountMissing: !existing,
    member: Boolean(existing && os.member(owner, account.gid)), source: dirname(spec.entry!),
    codeChanged: os.digest(dirname(spec.entry!)) !== os.digest(paths.code),
    runtime, runtimeMissing,
    plistChanged: previousPlist !== renderService(definition, label, choice.registered ? choice.enabled : Boolean(definition.automatic)),
    registered: choice.registered, enabled: choice.enabled, label, previousPlist,
    job, legacyJob,
    legacyPlist, legacyExists, legacyNames: legacyExists ? os.environmentNames(legacyPlist) : [],
    missing: [paths.code, ...(runtimeMissing ? [dirname(paths.runtime)] : []), paths.state, paths.logs, ...(legacyExists ? [paths.legacy] : [])].filter((path) => !os.exists(path)),
  };
}
export function planSystem(o: SystemObservation): SystemAction[] {
  const actions: SystemAction[] = [];
  const push = (kind: ActionKind, description: string) => actions.push({ kind, description });
  if (o.accountMissing) push("account", `create ${o.spec.user} (uid/gid ${o.account.uid})`);
  if (!o.member) push("group", `add ${o.owner} to ${o.account.group}; membership reaches new login sessions only`);
  for (const path of o.missing) {
    const root = path === o.paths.code || path === o.paths.legacy || path === dirname(o.paths.runtime);
    actions.push({ kind: "directory", path, uid: root ? 0 : o.account.uid, gid: root ? 0 : o.account.gid, mode: path === o.paths.logs ? 0o700 : root ? 0o755 : 0o750, description: `create ${path} (${root ? "root:wheel" : o.spec.user} ${path === o.paths.logs ? "0700" : root ? "0755" : "0750"})` });
  }
  if (o.codeChanged) push("stage", `install ${o.source} into ${o.paths.code}.staging (read-only, root:wheel)`);
  if (o.runtimeMissing) push("stage-runtime", `install runtime node v${o.runtime.version} (sha256 verified) into ${o.paths.runtime}.staging (read-only, root:wheel)`);
  if (o.codeChanged || o.runtimeMissing) {
    const { node, code } = provenPaths(o);
    push("load", `load the native modules of ${code} with ${node} as ${o.spec.user}`);
  }
  const switching = o.codeChanged || o.runtimeMissing || o.plistChanged || !o.registered || !o.job.pid || o.legacyExists || o.legacyJob.loaded;
  if (!switching) return actions;
  if (o.legacyExists) push("save", `save ${o.legacyPlist} to ${o.paths.legacy} (root 0600)`);
  if (o.legacyJob.loaded) push("stop-legacy", `stop ${legacyLabel(o.spec.key)} (launchctl bootout system/${legacyLabel(o.spec.key)})`);
  if (o.codeChanged) push("swap", `swap ${o.paths.code}.staging into ${o.paths.code}; keep .previous`);
  if (o.runtimeMissing) push("swap-runtime", `swap ${o.paths.runtime}.staging into ${o.paths.runtime}; keep .previous`);
  if (!o.registered || o.plistChanged) push("add", `write ${join(o.paths.plists, `${o.label}.plist`)} for the instance label`);
  if (!o.registered && o.definition.automatic) push("enable", `enable ${o.spec.key} at boot`);
  if (!o.job.pid || o.codeChanged || o.runtimeMissing || o.plistChanged || o.legacyJob.loaded) push(o.job.pid ? "restart" : "start", `${o.job.pid ? "restart" : "start"} ${o.spec.key} (launchctl bootstrap system / kickstart instance label)`);
  push("health", `wait for ${o.definition.health ?? "process readiness"} on unix://${o.spec.socket ?? ""} (60 s)`);
  if (o.legacyExists) push("remove-legacy", `remove ${o.legacyPlist}`);
  return actions;
}
/** What the pre-switch proof runs: the staged runtime and code when they are staged, else the installed ones. */
function provenPaths(o: SystemObservation): { node: string; code: string } {
  return {
    node: join(o.runtimeMissing ? `${o.paths.runtime}.staging` : o.paths.runtime, "bin", "node"),
    code: o.codeChanged ? `${o.paths.code}.staging` : o.paths.code,
  };
}
export async function applySystem(management: ServiceManagement, o: SystemObservation, actions: SystemAction[], os: SystemOS, serviceOS: ServiceOS, wait = waitForServices): Promise<void> {
  let switching = false, swapped = false, swappedRuntime = false;
  try {
    for (const action of actions) {
      switch (action.kind) {
        case "account": os.createAccount(o.spec.user!, o.account.uid); break;
        case "group": os.addMember(o.owner, o.account.group); break;
        case "directory": os.directory(action.path!, action.uid!, action.gid!, action.mode!); break;
        case "stage": os.stage(o.source, o.paths.code); break;
        case "stage-runtime": os.stageRuntime(o.paths.tarball, o.runtime.sha256, o.paths.runtime); break;
        case "load": { const { node, code } = provenPaths(o); os.loadNativeModules(node, code, o.account); break; }
        case "save": os.saveLegacy(o.legacyPlist, join(o.paths.legacy, `${legacyLabel(o.spec.key)}.plist`)); break;
        case "stop-legacy": switching = true; await serviceOS.unload("system", legacyLabel(o.spec.key), 40000); break;
        case "swap": switching = true; os.swap(o.paths.code); swapped = true; break;
        case "swap-runtime": switching = true; os.swap(o.paths.runtime); swappedRuntime = true; break;
        case "add": case "enable": case "start": case "restart": switching = true; await management.apply(o.spec.key, action.kind); break;
        case "health": await wait(management, [o.spec.key], { [o.spec.key]: { url: o.spec.socket ? `unix://${o.spec.socket}` : undefined } }, 60000); break;
        case "remove-legacy": os.remove(o.legacyPlist); break;
      }
    }
  } catch (error) {
    if (!switching) throw error;
    let restored = "previous stopped state";
    try {
      // Quiesce the replacement before changing its files or bringing back the legacy listener.
      await management.apply(o.spec.key, "remove");
      if (swapped) os.restore(o.paths.code);
      if (swappedRuntime) os.restore(o.paths.runtime);
      if (o.legacyJob.loaded) {
        serviceOS.load("system", o.legacyPlist);
        restored = legacyLabel(o.spec.key);
      } else if (o.registered) {
        await management.apply(o.spec.key, "add");
        if (o.enabled) await management.apply(o.spec.key, "enable");
        if (o.previousPlist !== undefined) os.writePlist(join(o.paths.plists, `${o.label}.plist`), o.previousPlist);
        if (o.job.loaded && o.previousPlist !== undefined) {
          serviceOS.enable("system", o.label, true);
          try {
            serviceOS.load("system", join(o.paths.plists, `${o.label}.plist`));
            if (o.job.pid && !serviceOS.inspect("system", o.label).pid) serviceOS.start("system", o.label);
          } finally { serviceOS.enable("system", o.label, o.enabled); }
          restored = o.label;
        }
      }
    } catch (rollback) { throw new Error(`${o.spec.key} switch failed: ${String(error)}; rollback failed: ${String(rollback)}`); }
    throw new Error(`${o.spec.key} switch failed: ${String(error)}; restored ${restored}`);
  }
}
export function reportSystem(o: SystemObservation, actions: SystemAction[], dryRun: boolean): string[] {
  const lines = [`${o.spec.key} runs as ${o.spec.user}`, `  account ${o.spec.user} ${o.accountMissing ? "missing" : `exists (uid ${o.account.uid})`}; ${o.owner} ${o.member ? "is" : "is not"} in its group`];
  if (dryRun) for (const action of actions) lines.push(`  would ${action.description}`);
  else lines.push(`${o.spec.key}: ${o.enabled || (!o.registered && o.definition.automatic) ? "enabled" : "disabled"} (system)`);
  if (!dryRun || !o.runtimeMissing) lines.push(`  runtime node v${o.runtime.version} at ${o.paths.runtime}${o.runtimeMissing ? " (installed now; pinned sha256 verified)" : ""}`);
  if (!dryRun && actions.some((action) => action.kind === "group")) lines.push("  note: group membership reaches new login sessions only");
  if (o.legacyNames === undefined) lines.push("  note: the legacy plist's environment cannot be read without sudo");
  else if (o.legacyNames.length) lines.push(`  legacy environment names: ${o.legacyNames.join(", ")}; rotate them: \`launchctl print\` showed them to every local user`);
  return lines;
}
export async function setupSystem(home: string, serviceOS: ServiceOS, os: SystemOS, options: { dryRun?: boolean; paths?: typeof systemPaths; wait?: typeof waitForServices; log?: (line: string) => void } = {}): Promise<void> {
  const uid = os.uid();
  if (!options.dryRun && uid !== 0) throw new Error("system setup needs root; run `sudo barry setup --system`");
  const invoking = uid === 0 ? os.sudoUid() : uid;
  if (!Number.isSafeInteger(invoking) || invoking === undefined || invoking <= 0) throw new Error("system setup needs SUDO_UID from the invoking user");
  if (!os.exists(join(home, "instance.json"))) throw new Error("run `barry setup` first (missing instance.json)");
  const instance = openInstance(home);
  if (instance.uid !== invoking) throw new Error("SUDO_UID differs from the instance uid");
  const managed = join(home, "managed-definitions.json"), prepared = join(home, "service-definitions.json");
  if (!os.exists(managed) || !os.exists(prepared)) throw new Error("run `barry setup` first (missing definitions)");
  const definitions = JSON.parse(os.read(managed)) as ServiceDefinition[];
  const specs = JSON.parse(os.read(prepared)) as Record<string, ServiceSpec>;
  const management = new ServiceManagement(instance, definitions, serviceOS);
  for (const spec of Object.values(specs)) {
    if (spec.user && !definitions.some((definition) => definition.name === spec.key && isSystemService(definition)))
      throw new Error(`${spec.key}: run \`barry setup\` first (missing system definition)`);
  }
  // Observe everything before any account, file, or launchd mutation.
  const observations = definitions.filter((definition) => isSystemService(definition) && specs[definition.name]).map((definition) => {
    const spec = specs[definition.name];
    if (!spec) throw new Error(`${definition.name}: run \`barry setup\` first (missing spec)`);
    return observeSystem(management, spec, os, serviceOS, (options.paths ?? systemPaths)(instance, spec.bag, spec.key));
  });
  const accounts = new Map<string, SystemAccount>();
  const ids = observations.some((o) => o.accountMissing) ? os.ids() : { uids: [], gids: [] };
  const seenGroups = new Set<string>(), runtimes = new Set<string>();
  for (const o of observations) {
    const name = o.spec.user!;
    if (o.accountMissing) {
      const reserved = accounts.get(name);
      if (reserved) { o.account = reserved; o.accountMissing = false; }
      else {
        const id = selectAccountId(ids);
        o.account = { uid: id, gid: id, group: name };
        accounts.set(name, o.account); ids.uids.push(id); ids.gids.push(id);
      }
    }
    if (seenGroups.has(o.account.group)) o.member = true;
    seenGroups.add(o.account.group);
    // Services share the instance's runtime: the first installs it, the rest find it in place.
    if (runtimes.has(o.paths.runtime)) o.runtimeMissing = false;
    runtimes.add(o.paths.runtime);
  }
  const plans = observations.map(planSystem);
  const log = options.log ?? console.log;
  log(`System services · instance ${instance.id} · owner ${os.owner(instance.uid)} (${instance.uid})`);
  const release = options.dryRun || !plans.some((plan) => plan.length) ? undefined : acquireLock(instance.home, "system-setup");
  try {
    for (const [index, o] of observations.entries()) {
      if (!options.dryRun) await applySystem(management, o, plans[index], os, serviceOS, options.wait);
      for (const line of reportSystem(o, plans[index], Boolean(options.dryRun))) log(line);
    }
  } finally { release?.(); }
}
export function systemNeeds(management: ServiceManagement, spec: ServiceSpec, os: SystemOS, serviceOS: ServiceOS): string {
  const definition = management.definition(spec.key);
  const reasons: string[] = [];
  if (!management.choice(spec.key).registered || !os.exists(join(definition.plistDirectory, `${management.label(spec.key)}.plist`))) reasons.push("not installed");
  if (!spec.entry || !os.exists(spec.entry)) reasons.push(`build it first with \`pnpm --filter @barry-rocks/${spec.bag}-bag build\``);
  else if (os.digest(dirname(spec.entry)) !== os.digest(definition.directory)) reasons.push("its code changed");
  if (!os.exists(definition.command[0])) reasons.push(`its runtime node v${nodeRuntime().version} is not installed`);
  if (serviceOS.inspect("system", legacyLabel(spec.key)).loaded) reasons.push(`runs under the legacy label ${legacyLabel(spec.key)}`);
  return reasons.length ? `${spec.key}: needs \`sudo barry setup --system\` (${reasons.join("; ")})` : `${spec.key}: enabled (system)`;
}
