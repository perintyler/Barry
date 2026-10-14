import { parseManifest } from "../../bags/manifest.js";
import { validateNativeTools } from "../../bounds/native-policy.js";
import type { BagManifest } from "../../bags/types.js";
/**
 * `Adapters` over a record file: which adapters are installed, from where.
 *
 * Names no harness. The record holds what Barry can know without running an
 * adapter's code — enough for `barry adapter list`, doctor and the UI, which
 * must work even when that code no longer loads. Loading imports from the
 * recorded path and checks the adapter again, because the code on disk can
 * have changed since it was added.
 */
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { acquireLock } from "../../services/lock.js";
import { parseInstalledAdapters } from "./records.js";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { MODE_IDS, type HarnessId, type ModeId } from "../../ids.js";
import { defineVendorCode, mergeVendorFactories, type VendorCode, type VendorFactories } from "../models/vendors/catalog.js";
import type { Vendor } from "../models/vendors/index.js";
import { checkAdapter } from "./check.js";
import {
  AdapterNotInstalled,
  AdapterRefused,
  findInstalled,
  type Adapter,
  type Adapters,
  type InstalledAdapter,
  type Mode,
} from "./index.js";

export interface AdapterStoreOptions {
  /** The record file: an installation keeps it at `barryAdaptersPath()`. */
  file: string;
  /** Imports a module by absolute path. Injected so a test needs no package on disk. */
  importModule?: (entry: string) => Promise<unknown>;
  now?: () => Date;
  /** The composition root registers this through its ordinary bag registry. */
  registerBag?: (name: string, path: string, manifest: BagManifest) => Promise<void>;
}

export function loadAdapters(options: AdapterStoreOptions): Adapters {
  const importModule = options.importModule ?? ((entry: string) => import(pathToFileURL(entry).href));
  const now = options.now ?? (() => new Date());

  function installed(): InstalledAdapter[] {
    if (!existsSync(options.file)) return [];
    try { return parseInstalledAdapters(JSON.parse(readFileSync(options.file, "utf8"))); }
    catch { throw new Error(`${options.file}: invalid installed session registry; preserve a backup and reselect packages with barry adapter add <package-directory>`); }
  }

  function save(records: InstalledAdapter[]): void {
    parseInstalledAdapters(records);
    mkdirSync(dirname(options.file), { recursive: true });
    const temporary = `${options.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temporary, options.file);
    } finally { rmSync(temporary, { force: true }); }
  }

  function snapshot(adapter: Adapter, path: string, packageName: string, version: string, vendorCode?: VendorCode, bag?: InstalledAdapter["bag"]): InstalledAdapter {
    const entry: InstalledAdapter = {
      id: adapter.id, packageName, contractVersion: 1,
      ...(bag ? { bag } : {}),
      ...(adapter.aliases?.length ? { aliases: [...adapter.aliases] } : {}),
      label: adapter.label,
      ...(adapter.experimental !== undefined ? { experimental: adapter.experimental } : {}),
      ...(adapter.vendor ? { vendor: adapter.vendor } : {}),
      ...(adapter.offeredModels ? { offeredModels: adapter.offeredModels.map(model => ({ ...model })) } : {}),
      requirements: adapter.requirements, capabilities: adapter.capabilities,
      nativeTools: [...adapter.nativeTools], defaultMode: adapter.defaultMode, modes: declarations(adapter),
      ...(vendorCode ? { vendorCode: { vendors: vendorCode.vendors } } : {}),
      path, version, installedAt: now().toISOString(),
    };
    try { return parseInstalledAdapters(JSON.parse(JSON.stringify([entry])))[0]; }
    catch { throw new AdapterRefused(adapter.id, ["adapter metadata has an invalid persisted shape"]); }
  }

  function nextRecords(records: InstalledAdapter[], entry: InstalledAdapter): InstalledAdapter[] {
    const own = records.find(record => record.packageName === entry.packageName);
    if (records.some(record => record.path === entry.path && record.packageName !== entry.packageName)) throw new AdapterRefused(entry.id, ["another package owns this adapter path; remove its selection first"]);
    const others = records.filter(record => record.packageName !== entry.packageName);
    const names = new Set([entry.id, ...entry.aliases ?? []]);
    const claimant = others.find(record => [record.id, ...record.aliases ?? []].some(name => names.has(name)));
    if (claimant) throw new AdapterRefused(entry.id, [`the adapter "${claimant.id}" at ${claimant.path} already answers to one of this adapter's names`]);
    const claimed = entry.vendorCode?.vendors.flatMap(vendor => {
      const owner = others.find(record => record.vendorCode?.vendors.some(other => other.id === vendor.id));
      return owner ? [`the vendor ${vendor.id} (already declared by "${owner.id}" at ${owner.path}) is already declared by an installed adapter`] : [];
    }) ?? [];
    if (claimed.length) throw new AdapterRefused(entry.id, claimed);
    return [...others, own && sameDeclarations(own, entry) ? own : entry];
  }

  function requireCurrent(entry: InstalledAdapter, current: InstalledAdapter): void {
    if (!sameDeclarations(entry, current)) throw new AdapterRefused(entry.id, [`${entry.packageName} changed its contract, version or declarations; run barry adapter add ${entry.path} again`]);
  }

  async function inspect(path: string): Promise<{ adapter: Adapter; packageName: string; version: string; vendorCode?: VendorCode; bag?: InstalledAdapter["bag"] }> {
    const pkg = readPackage(path);
    let loaded: { default?: unknown; vendorCode?: unknown };
    try { loaded = await importModule(join(path, pkg.entry)) as typeof loaded; }
    catch { throw new AdapterRefused(pkg.name, [`${pkg.name} could not load; reinstall it, then run barry adapter add ${path}`]); }
    const adapter = loaded.default as Adapter | undefined;
    if (!adapter || typeof adapter !== "object") {
      throw new AdapterRefused(pkg.name, [`${pkg.name} has no default export; export defineAdapter({...}) as default`]);
    }
    // The bag manifest is read BEFORE the checker runs: the credentials rule
    // reads the declaration off the manifest, so it must exist by then.
    const problems: string[] = [];
    let bag: InstalledAdapter["bag"];
    let bagManifest: import("../../bags/types.js").BagManifest | undefined;
    if (adapter.bag !== undefined) {
      try {
        if (typeof adapter.bag !== "string" || isAbsolute(adapter.bag)) throw new Error("adapter bag must be a relative directory");
        const directory = resolve(path, adapter.bag);
        if (relative(path, directory).split(/[\\/]/).includes("..")) throw new Error("adapter bag must stay within its package");
        if (relative(realpathSync(path), realpathSync(directory)).split(/[\\/]/).includes("..")) throw new Error("adapter bag must stay within its package");
        const manifest = parseManifest(directory);
        if (!manifest) throw new Error(`adapter bag at ${directory} has no bag.yaml`);
        bagManifest = manifest;
        validateNativeTools(manifest, adapter);
        bag = { path: directory, manifest };
      } catch (err) { problems.push(err instanceof Error ? err.message : String(err)); }
    }
    const { problems: checkedProblems, checked } = checkAdapter(adapter, { bagManifest });
    problems.push(...checkedProblems);
    if (checked === 0) throw new Error("the adapter checker ran no checks");
    // Vendor code is optional, but present it must cohere: a factory naming a
    // vendor the package does not declare is refused here, at the install,
    // not at the first call that tries to reach it.
    let vendorCode: VendorCode | undefined;
    if (loaded.vendorCode !== undefined) {
      try {
        vendorCode = defineVendorCode(loaded.vendorCode as VendorCode);
      } catch (err) {
        problems.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (bag?.manifest.vendors) {
      if (vendorCode?.vendors.length) throw new Error("vendor rows must be declared in the bag alone");
      const module = loaded as { vendorFactories?: VendorFactories };
      vendorCode = defineVendorCode({ vendors: bag.manifest.vendors, factories: module.vendorFactories ?? vendorCode?.factories ?? {} });
    }
    if (problems.length > 0) throw new AdapterRefused(adapter.id || pkg.name, problems);
    return { adapter, packageName: pkg.name, version: pkg.version, vendorCode, bag };
  }

  return {
    installed,

    vendorRows(): Vendor[] {
      return installed().flatMap((record) => record.vendorCode?.vendors ?? []);
    },

    async loadVendorCode(): Promise<{ factories: VendorFactories; refused: Map<string, string[]> }> {
      let factories: VendorFactories = {};
      const refused = new Map<string, string[]>();
      for (const entry of installed()) {
        if (!entry.vendorCode) continue;
        try {
          const current = await inspect(entry.path);
          requireCurrent(entry, snapshot(current.adapter, entry.path, current.packageName, current.version, current.vendorCode, current.bag));
          if (!current.vendorCode) throw new Error("the package no longer declares vendor code");
          factories = mergeVendorFactories(factories, current.vendorCode.factories);
        } catch (error) {
          refused.set(entry.id, error instanceof AdapterRefused ? error.problems : [error instanceof Error ? error.message : "adapter vendor code is unavailable"]);
        }
      }
      return { factories, refused };
    },

    async add(path, addOptions = {}) {
      const directory = resolve(path);
      const current = await inspect(directory);
      const entry = snapshot(current.adapter, directory, current.packageName, current.version, current.vendorCode, current.bag);
      const release = acquireLock(dirname(options.file), "session-adapters");
      try {
        const records = nextRecords(installed(), entry);
        const ailments = await addOptions.vet?.(current.adapter) ?? [];
        if (ailments.length) throw new AdapterRefused(entry.id, ailments);
        if (current.bag) await options.registerBag?.(current.bag.manifest.name, current.bag.path, current.bag.manifest);
        if (!isDeepStrictEqual(installed(), records)) save(records);
        return records.find(record => record.packageName === entry.packageName)!;
      } finally { release(); }
    },

    remove(id: HarnessId): boolean {
      const release = acquireLock(dirname(options.file), "session-adapters");
      try {
        const records = installed();
        const entry = findInstalled(records, id);
        if (!entry) return false;
        save(records.filter(record => record.packageName !== entry.packageName));
        return true;
      } finally { release(); }
    },

    async load(id: HarnessId) {
      const entry = findInstalled(installed(), id);
      if (!entry) throw new AdapterNotInstalled(id);
      const current = await inspect(entry.path);
      requireCurrent(entry, snapshot(current.adapter, entry.path, current.packageName, current.version, current.vendorCode, current.bag));
      const selected = findInstalled(installed(), id);
      if (!selected) throw new AdapterNotInstalled(id);
      requireCurrent(entry, selected);
      if (current.bag) await options.registerBag?.(current.bag.manifest.name, current.bag.path, current.bag.manifest);
      // Recheck after asynchronous registration; readers never republish a removed selection.
      const settled = findInstalled(installed(), id);
      if (!settled) throw new AdapterNotInstalled(id);
      requireCurrent(entry, settled);
      return current.adapter;
    },

  };
}

function declarations(adapter: Adapter): Record<ModeId, Mode | null> {
  const out = {} as Record<ModeId, Mode | null>;
  for (const slot of MODE_IDS) {
    const mode = adapter.modes[slot];
    out[slot] = mode
      ? {
          guarantees: { ...mode.guarantees },
          ...(mode.native ? { native: structuredClone(mode.native) } : {}),
          verifiedOn: mode.verifiedOn,
          evidence: { ...mode.evidence },
          egressSandbox: mode.egressSandbox,
          ...(mode.approvalContinuation ? { approvalContinuation: mode.approvalContinuation } : {}),
          ...(mode.platforms ? { platforms: [...mode.platforms] } : {}),
          ...(mode.attachesTo ? { attachesTo: mode.attachesTo } : {}),
        }
      : null;
  }
  return out;
}

function readPackage(directory: string): { name: string; version: string; entry: string } {
  const file = join(directory, "package.json");
  if (!existsSync(file)) throw new Error(`No session adapter package at ${directory}; install it, then run barry adapter add <package-directory>`);
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  const contract = z.strictObject({ contractVersion: z.literal(1) }).safeParse(pkg.barry?.sessionAdapter);
  if (!contract.success) throw new Error(`${file}: unsupported session adapter contract; expected barry.sessionAdapter with contractVersion 1`);
  if (typeof pkg.name !== "string" || !pkg.name || typeof pkg.version !== "string" || !pkg.version) throw new Error(`${file}: session adapter needs a package name and version`);
  const root = typeof pkg.exports === "string" ? pkg.exports : pkg.exports?.["."];
  const entry = typeof root === "string" ? root : root?.import;
  if (pkg.type !== "module" || typeof entry !== "string" || !entry.startsWith("./") || !/\.m?js$/.test(entry)) throw new Error(`${file}: session adapter must export compiled ESM at exports["."].import`);
  const absolute = resolve(directory, entry);
  if (relative(directory, absolute).split(/[\\/]/).includes("..")) throw new Error(`${file}: session adapter export escapes its package`);
  if (!existsSync(absolute)) throw new Error(`${pkg.name} is missing its compiled entry; reinstall with npm install ${pkg.name}`);
  if (relative(realpathSync(directory), realpathSync(absolute)).split(/[\\/]/).includes("..")) throw new Error(`${file}: session adapter export escapes its package`);
  return { name: pkg.name, version: pkg.version, entry };
}

function sameDeclarations(a: InstalledAdapter, b: InstalledAdapter): boolean {
  const { installedAt: _a, ...left } = a;
  const { installedAt: _b, ...right } = b;
  return isDeepStrictEqual(left, right);
}
