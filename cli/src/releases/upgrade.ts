import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { barryAppSupportDir, barryCurrentDir, barryReleasesDir, barryStoresDir, readServiceRegistry } from "@barry-rocks/sdk/services";
import { acquireLock } from "@barry-rocks/sdk/internal/services";
import { managedServices } from "@barry-rocks/mcp-bag";
import { waitForServices } from "@barry-rocks/mcp-bag";
import { launchd } from "@barry-rocks/mcp-bag";
import { connectLocal } from "@barry-rocks/sdk/internal/client";
import { activateStoreGeneration, activeStoreRoot, interruptedStoreGeneration, prepareStoreGeneration, previousStoreGeneration, validatePreparedStoreGeneration } from "@barry-rocks/sdk/internal/stores";
import { generationSize } from "../commands/db-rollback.js";
import { pruneOlderGenerations } from "../commands/db-prune.js";
import { storeServices, switchStoreGeneration, type StoreServices } from "../commands/db-services.js";
import { assertStoreSpace, snapshotStores } from "../commands/db-stores.js";
import { systemNeeds, systemOS } from "../services/system.js";
import type { ServiceSpec } from "../services/specs.js";
import { copyRelease, currentInstallation, installationExists, installationPath, linkedNode, pointCurrent, pruneReleases, releaseBytes } from "./current.js";
import { installationLabel, readReceipts, receiptId, writeReceipt, type Installation, type Receipt } from "./receipts.js";
import { readRelease, releaseRoot, type Release } from "./release.js";
import { migrateCandidate, storeSchemas, storeVersions } from "./schemas.js";

interface ChildOptions { cwd: string; env: NodeJS.ProcessEnv }
interface UpgradeDependencies {
  release?: { root: string; release: Release };
  services?: StoreServices;
  run?(this: void, program: string, args: string[], options: ChildOptions): Promise<void> | void;
  runningSessions?(): Promise<{ id: string; status: string }[]>;
  waitForHealth?(keys: string[]): Promise<void>;
  confirm?(message: string): Promise<boolean>;
}
function childEnvironment(target: Installation): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ["BARRY_DIR", "BARRY_BUILTIN_DIR", "BARRY_HOOK_DISPATCHER", "BARRY_NODE"]) delete env[name];
  if (target.kind === "link") env.BARRY_NODE = target.node;
  return env;
}
function runChild(program: string, args: string[], options: ChildOptions): void {
  const result = spawnSync(program, args, { ...options, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${args.join(" ")} exited ${result.status ?? result.signal}`);
}
function selectedGeneration(root: string): string | null {
  const marker = join(root, "active.json");
  return existsSync(marker) ? (JSON.parse(readFileSync(marker, "utf8")) as { id: string }).id : null;
}
function sameInstallation(left: Installation, right: Installation): boolean {
  return left.kind === "release" && right.kind === "release" ? left.commit === right.commit
    : left.kind === "link" && right.kind === "link" && left.target === right.target;
}
function activeInstallation(): Installation {
  const current = currentInstallation();
  if (!current.current) throw new Error("This instance has no current installation. Run `barry setup` from a release, or `barry setup --link <checkout>`, first.");
  if (current.kind === "missing") throw new Error(`current points at ${current.target}, which does not exist; run barry setup --link <checkout>, or remove current and run a release's barry setup`);
  if (current.kind === "release") return { kind: "release", version: current.version!, commit: current.commit! };
  const node = linkedNode();
  if (!node) throw new Error(`Cannot tell which Node the linked checkout at ${current.target} runs; run \`BARRY_NODE=<node> barry upgrade\`.`);
  return { kind: "link", target: current.target!, commit: current.commit ?? null, node };
}
function assertReadable(directory: string, schemas: Record<string, number>, target: Installation): void {
  for (const [key, version] of Object.entries(storeVersions(directory))) {
    if (Object.hasOwn(schemas, key) && version > schemas[key])
      throw new Error(`${key} is at schema ${version}; ${installationLabel(target)} knows ${schemas[key]}. This release is older than the stores.`);
  }
}
function schemaChanges(from: Record<string, number>, to: Record<string, number>): string[] {
  return [...new Set([...Object.keys(from), ...Object.keys(to)])].sort()
    .filter(key => from[key] !== to[key]).map(key => `${key} ${from[key] ?? "absent"} → ${to[key] ?? "absent"}`);
}
function checkCopy(directory: string, version: string): void {
  const home = mkdtempSync(join(tmpdir(), "barry-upgrade-check-"));
  try {
    const result = spawnSync(join(directory, "bin/barry"), ["--version"], { encoding: "utf8", env: { HOME: home, BARRY_HOME: home, PATH: "/usr/bin:/bin" } });
    if (result.error || result.status !== 0 || result.stdout.trim() !== version)
      throw new Error(`copied release failed its version check: ${result.error?.message ?? result.stderr.trim() ?? result.status}`);
  } finally { rmSync(home, { recursive: true, force: true }); }
}
async function snapshot(): Promise<string> {
  const result = await snapshotStores();
  console.log(`Pre-switch snapshot created: ${result.directory}`);
  for (const line of result.lines) console.log(line);
  return result.directory;
}

/** Keep the saved restart set across an interruption and skip removed services. */
function releaseServices(base: StoreServices, target: Installation, saved: string[], injected: boolean, started: Set<string>, remember: (key: string) => void): StoreServices {
  const pending = new Set(saved), removed = new Set<string>(), absent = new Set<string>();
  const exists = (key: string) => injected || managedServices().names().includes(key);
  return {
    statuses: async () => {
      const statuses = await base.statuses();
      for (const key of pending) if (!statuses.some(status => status.key === key && status.pid)) {
        const index = statuses.findIndex(status => status.key === key);
        const status = { key, pid: 1, state: "running" as const };
        if (index < 0) statuses.push(status); else statuses[index] = status;
      }
      for (const key of absent) statuses.push({ key, pid: undefined, state: "stopped" });
      for (const key of removed) statuses.push({ key, pid: 1, state: "running" });
      return statuses;
    },
    isSystem: key => pending.has(key) && !exists(key) ? false : base.isSystem(key),
    stop: async key => { pending.delete(key); remember(key); if (exists(key)) await base.stop(key); else absent.add(key); },
    start: async key => {
      if (!exists(key)) { absent.delete(key); removed.add(key); console.log(`${key} is no longer defined by ${installationLabel(target)}`); return; }
      await base.start(key); started.add(key);
    },
  };
}
async function printPlan(from: Installation, to: Installation, changes: string[], services: string[], options: UpgradeDependencies, warning?: string): Promise<string> {
  console.log(`Current: ${installationLabel(from)}${from.kind === "link" ? ` (${from.commit ?? "unknown commit"})` : ""}`);
  console.log(`Target: ${installationLabel(to)}`);
  for (const change of changes) console.log(`  ${change}`);
  if (changes.length) console.log(`A store generation of ${generationSize(activeStoreRoot()).bytes} bytes is prepared after services stop.`);
  console.log(`User services to restart: ${services.join(", ") || "none"}. System services keep running.`);
  try {
    const sessions = options.runningSessions ? await options.runningSessions() : (await (await connectLocal()).sessions.list({ active: true })).sessions;
    for (const session of sessions.filter(session => session.status === "running")) console.log(`Running session: ${session.id}`);
  } catch (error) { console.log(`could not list running sessions: ${String(error)}`); }
  console.log("System services keep their code until `sudo barry setup --system`; services needing it are listed afterwards.");
  if (warning) console.log(warning);
  return `Move ${installationLabel(from)} to ${installationLabel(to)}?${warning ? ` ${warning}` : ""}`;
}
async function confirmed(options: { yes?: boolean } & UpgradeDependencies, message: string): Promise<boolean> {
  if (options.yes) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Unattended upgrade requires --yes");
  const answer = options.confirm ? await options.confirm(message) : await (await import("@inquirer/prompts")).confirm({ message, default: false });
  if (!answer) console.log("No changes made.");
  return answer;
}
async function finish(receipt: Receipt, before: Set<string>, started: Set<string>, services: StoreServices, options: UpgradeDependencies): Promise<void> {
  const management = managedServices();
  for (const key of management.names()) {
    const definition = management.definition(key), choice = management.choice(key);
    if (!before.has(key) && definition.domain !== "system" && !definition.user && choice.registered && choice.enabled) {
      await services.start(key); console.log(`Started new service ${key}`);
    }
  }
  try {
    if (options.waitForHealth) await options.waitForHealth([...started]);
    else await waitForServices(managedServices(), [...started], readServiceRegistry().resources, 300_000);
  } catch (error) {
    const back = receipt.kind === "rollback" ? `\`barry upgrade\` from ${installationLabel(receipt.from)} returns to it` : `\`barry upgrade --rollback\` returns to ${installationLabel(receipt.from)}`;
    throw new Error(`${String(error)}. If ${installationLabel(receipt.to)} is at fault, ${back}.`, { cause: error });
  }
  if (!options.services) {
    const management = managedServices(), os = systemOS(), serviceOS = launchd();
    const path = join(barryAppSupportDir(), "service-definitions.json");
    const specs = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Record<string, ServiceSpec> : {};
    for (const key of management.names()) {
      const definition = management.definition(key);
      if (definition.domain === "system" || definition.user) {
        console.log(specs[key] ? systemNeeds(management, specs[key], os, serviceOS) : `${key}: needs \`sudo barry setup --system\` (missing prepared spec)`);
      }
    }
  }
  for (const line of await pruneOlderGenerations(barryStoresDir())) console.log(line);
  for (const line of pruneReleases()) console.log(line);
}

export async function upgradeCommand(options: { yes?: boolean; rollback?: boolean } & UpgradeDependencies = {}): Promise<void> {
  const root = options.release?.root ?? releaseRoot(), release = options.release?.release ?? readRelease(root);
  if (!release) throw new Error(`barry upgrade installs the release it runs from; ${root} is a checkout. Run a checkout with \`barry setup --link <checkout>\`.`);
  if (process.getuid?.() === 0) throw new Error("barry upgrade must run as the instance's user, not root");
  // Validate the selector before acquiring the mutation lock.
  let from = activeInstallation();
  const unlock = acquireLock(barryReleasesDir(), "upgrade");
  try {
    const stores = barryStoresDir();
    if (interruptedStoreGeneration(stores)) throw new Error("A store switch was interrupted; run `barry db recover`, then `barry upgrade` again.");
    const latest = readReceipts()[0];
    let resume: Receipt | undefined;
    let saved: string[] = [];
    const installed: Installation = { kind: "release", version: release.version, commit: release.commit };
    const unfinished = latest && ["started", "switched"].includes(latest.state) ? latest : undefined;
    // A rollback finishes through --rollback: its target may be a linked checkout, which cannot run upgrade.
    if (unfinished?.kind === "rollback" && !options.rollback) throw new Error(`A rollback to ${installationLabel(unfinished.to)} is unfinished; run \`barry upgrade --rollback\` to finish it.`);
    if (unfinished && (unfinished.kind === "rollback" || !options.rollback)) {
      if (unfinished.kind === "upgrade" && !sameInstallation(unfinished.to, installed)) throw new Error(`An upgrade to ${installationLabel(unfinished.to)} is unfinished; run '${installationPath(unfinished.to)}/bin/barry' upgrade to finish it${unfinished.state === "switched" ? ", or `barry upgrade --rollback`" : ""}.`);
      saved = unfinished.services;
      if (unfinished.state === "switched" || unfinished.generations.after !== null && unfinished.generations.after === selectedGeneration(stores)) {
        if (!installationExists(unfinished.to)) throw new Error(`${installationLabel(unfinished.to)} is missing, so the interrupted ${unfinished.kind} cannot finish`);
        resume = unfinished;
      } else {
        pointCurrent(installationPath(unfinished.from));
        writeReceipt({ ...unfinished, state: "reverted", finished: new Date().toISOString(), problem: "interrupted before the switch" });
        from = unfinished.from;
      }
    }
    let to: Installation = resume?.to ?? installed;
    let source: string | undefined;
    // A reverted receipt changed nothing, so the change to undo is the newest one that did.
    const undone = options.rollback && !resume ? readReceipts().find(receipt => receipt.state !== "reverted") : undefined;
    if (options.rollback && !resume) {
      if (!undone || undone.kind !== "upgrade" || !["switched", "complete"].includes(undone.state)) {
        if (undone?.kind === "rollback") throw new Error(`The last change was already a rollback to ${installationLabel(undone.to)}; run \`barry upgrade\` from ${installationLabel(undone.from)} to go forward.`);
        throw new Error("No completed or switched upgrade is available to roll back");
      }
      if (!sameInstallation(from, undone.to)) throw new Error("current is no longer the installation the last upgrade installed");
      if (!installationExists(undone.from)) throw new Error(`${installationLabel(undone.from)} is missing; rollback is not possible`);
      to = undone.from;
      if (undone.generations.after) {
        if (selectedGeneration(stores) !== undone.generations.after || previousStoreGeneration(stores)?.id !== undone.generations.before)
          throw new Error(`The stores changed since the upgrade (the active generation is now ${selectedGeneration(stores)}). Services restarted on ${installationLabel(from)} migrate any restored or rolled-back copy forward, so ${installationLabel(to)} may not read them. The rollback stops here; the snapshot taken before the upgrade is ${undone.snapshot}.`);
        source = undone.generations.before!;
      }
      assertReadable(source ? join(stores, "generations", source) : activeStoreRoot(), storeSchemas(installationPath(to)), to);
      saved = [...new Set([...saved, ...undone.services])];
    } else if (!resume && sameInstallation(from, to)) { console.log(`Already on release ${release.version}.`); return; }
    const changes = resume ? [] : schemaChanges(storeSchemas(installationPath(from)), options.rollback ? storeSchemas(installationPath(to)) : release.stores);
    if (!options.rollback && !resume) {
      if (changes.length && !selectedGeneration(stores)) throw new Error("This home's stores are not in a store generation yet, so an upgrade that changes their schemas cannot keep the old ones. Run `barry db backup`, then `barry db restore <that backup>`, then `barry upgrade` again.");
      assertReadable(activeStoreRoot(), release.stores, to);
    }
    const base = options.services ?? storeServices(), statuses = await base.statuses();
    const keys = [...new Set([...statuses.filter(service => service.pid && !base.isSystem(service.key)).map(service => service.key), ...saved])];
    const before = new Set([...statuses.map(service => service.key), ...managedServices().names()]);
    const warning = source && undone ? `Writes since ${previousStoreGeneration(stores)?.replacedAt.toISOString() ?? undone.finished ?? undone.started} stop being used. They stay in ${undone.generations.after} and in the snapshot.` : undefined;
    if (!await confirmed(options, await printPlan(from, to, changes, keys, options, warning))) return;
    let candidate: Awaited<ReturnType<typeof prepareStoreGeneration>> | undefined;
    let receipt = resume;
    if (!receipt) {
      if (!options.rollback) {
        const bytes = releaseBytes(root) + (changes.length ? generationSize(activeStoreRoot()).bytes : 0);
        assertStoreSpace(bytes, barryAppSupportDir(), "an upgrade");
        checkCopy(copyRelease(root, release), release.version);
      }
      const snapshotPath = !options.rollback || source ? await snapshot() : null;
      if (source) {
        assertStoreSpace(generationSize(join(stores, "generations", source)).bytes, stores, "a rollback generation");
        candidate = await prepareStoreGeneration({ root: stores, previousId: selectedGeneration(stores)!, source, servicesStopped: true });
        await validatePreparedStoreGeneration(stores, candidate.id);
      }
      receipt = { format: 1, id: receiptId(), kind: options.rollback ? "rollback" : "upgrade", state: "started", from, to,
        generations: { before: selectedGeneration(stores), after: candidate?.id ?? null }, snapshot: snapshotPath, services: keys, started: new Date().toISOString() };
      writeReceipt(receipt);
    }
    const journal = receipt, started = new Set<string>();
    const services = releaseServices(base, to, saved, Boolean(options.services), started, key => {
      if (!journal.services.includes(key)) { journal.services.push(key); writeReceipt(journal); }
    });
    try { await switchStoreGeneration({ command: options.rollback ? "Release rollback" : "Upgrade", previous: installationLabel(journal.from), services,
      async switch(stopAgain) {
        try {
          await stopAgain();
          if (!resume && !options.rollback && changes.length) {
            candidate = await prepareStoreGeneration({ root: stores, previousId: journal.generations.before!, servicesStopped: true, build: migrateCandidate(join(installationPath(to), "bags")) });
            journal.generations.after = candidate.id; writeReceipt(journal);
            await validatePreparedStoreGeneration(stores, candidate.id);
          }
          pointCurrent(installationPath(to));
          if (candidate && !resume) await activateStoreGeneration({ root: stores, id: candidate.id, previousId: journal.generations.before!, servicesStopped: true, rollbackOnFailure: true,
            validate: async () => { await validatePreparedStoreGeneration(stores, candidate!.id); }, sealPrevious: async () => {} });
        } catch (error) {
          if (resume) { journal.problem = String(error); writeReceipt(journal); throw error; }
          pointCurrent(installationPath(journal.from));
          journal.state = "reverted"; journal.problem = String(error); journal.finished = new Date().toISOString(); writeReceipt(journal); throw error;
        }
        journal.state = "switched"; delete journal.problem; writeReceipt(journal);
        const run = options.run ?? runChild, child = { cwd: barryCurrentDir(), env: childEnvironment(to) };
        let step = "setup";
        try {
          console.log(`Setting up ${installationLabel(to)}`);
          await run(join(barryCurrentDir(), "bin/barry"), ["setup", "--no-start"], child);
          step = "the bag build";
          await run(join(barryCurrentDir(), "bin/barry"), ["bag", "build", "--force"], child);
          journal.state = "complete"; journal.finished = new Date().toISOString(); writeReceipt(journal);
        } catch (error) {
          journal.state = "switched"; delete journal.finished;
          const ways = journal.kind === "rollback" ? "Run `barry upgrade --rollback` again to finish." : "Run `barry upgrade` again to finish, or `barry upgrade --rollback`.";
          journal.problem = `Switched to ${installationLabel(to)}, but ${step} failed: ${String(error)}. ${ways}`;
          writeReceipt(journal);
        }
        return { directory: installationPath(to) };
      },
    }); } catch (error) {
      // A stop may fail before the switch callback gets control.
      if (journal.state === "started" && (!journal.generations.after || selectedGeneration(stores) !== journal.generations.after)) {
        pointCurrent(installationPath(journal.from));
        journal.state = "reverted"; journal.problem = String(error); journal.finished = new Date().toISOString(); writeReceipt(journal);
      }
      throw error;
    }
    if (journal.problem) throw new Error(journal.problem);
    await finish(journal, before, started, services, options);
  } finally { unlock(); }
}
