/** Installation selections are data; only explicit loading imports provider code. */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { acquireLock } from "../../services/lock.js";
import { mergeVendorFactories, type VendorFactories } from "./vendors/models.js";

const descriptor = z.strictObject({ contractVersion: z.literal(1), factoryExport: z.string().regex(/^[A-Za-z_$][\w$]*$/) });
const registration = z.strictObject({
  packageName: z.string().min(1),
  path: z.string().refine(isAbsolute, "package path must be absolute"),
  version: z.string().min(1),
  contractVersion: z.literal(1),
  factoryExport: descriptor.shape.factoryExport,
  shipped: z.literal(true).optional(),
});
export type InstalledModelVendor = z.infer<typeof registration>;
export interface ModelVendorStoreOptions {
  file: string;
  /** Absolute module entry point; tests may inject imports without contacting a provider. */
  importModule?: (entry: string) => Promise<unknown>;
}
export interface ModelVendors {
  installed(): InstalledModelVendor[];
  add(path: string, options?: { shipped?: true }): Promise<InstalledModelVendor>;
  /** Refusals from the most recent load; selections remain recorded for repair. */
  refused: Map<string, string[]>;
  remove(packageName: string): boolean;
  /** Omitted names load registered selections. A named missing selection fails explicitly. */
  load(packageNames?: readonly string[]): Promise<VendorFactories>;
}

type ShippedModelVendor = Pick<InstalledModelVendor, "packageName" | "version" | "path"> & {
  contractVersion: unknown;
  factoryExport: unknown;
};

/** Discover declarations without importing code or requiring a built package. */
export function shippedModelVendors(root: string): ShippedModelVendor[] {
  const packages: ShippedModelVendor[] = [];
  for (const kind of ["completions", "embeddings", "decisions"]) {
    const directory = resolve(root, "adapters", kind);
    if (!existsSync(directory)) continue;
    for (const child of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (child.name === "node_modules" || !child.isDirectory()) continue;
      const path = join(directory, child.name);
      const file = join(path, "package.json");
      if (!existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, "utf8"));
      if (pkg.barry?.modelProvider === undefined) continue;
      packages.push({
        packageName: pkg.name, version: pkg.version, path,
        contractVersion: pkg.barry.modelProvider?.contractVersion,
        factoryExport: pkg.barry.modelProvider?.factoryExport,
      });
    }
  }
  return packages;
}

function packageInfo(directory: string): InstalledModelVendor & { entry: string } {
  const file = join(directory, "package.json");
  if (!existsSync(file)) throw new Error(`No model adapter package at ${directory}; install the package, then run barry adapter model add <package-directory>`);
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  const declared = descriptor.safeParse(pkg.barry?.modelProvider);
  if (!declared.success) throw new Error(`${file}: unsupported model provider contract; expected barry.modelProvider with contractVersion 1 and factoryExport`);
  const root = typeof pkg.exports === "string" ? pkg.exports : pkg.exports?.["."];
  const target = typeof root === "string" ? root : root?.import;
  if (typeof target !== "string" || !target.startsWith("./") || !target.endsWith(".js")) throw new Error(`${file}: model provider must export compiled ESM at exports["."].import`);
  const entry = resolve(directory, target);
  if (relative(directory, entry).split(/[\\/]/).includes("..")) throw new Error(`${file}: model provider export escapes its package`);
  const record = registration.parse({ packageName: pkg.name, version: pkg.version, path: directory, ...declared.data });
  if (!existsSync(entry)) throw new Error(`${record.packageName} is missing its compiled entry; reinstall with npm install ${record.packageName}`);
  return { ...record, entry };
}

const kinds = new Set(["completion", "decision", "embedding", "listModels", "check"]);
function factoriesOf(module: unknown, record: InstalledModelVendor): VendorFactories {
  const value = (module as Record<string, unknown> | null)?.[record.factoryExport];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${record.packageName} does not export ${record.factoryExport} as factory maps`);
  let count = 0;
  for (const [kind, map] of Object.entries(value)) {
    if (!kinds.has(kind) || !map || typeof map !== "object" || Array.isArray(map)) throw new Error(`${record.packageName} has an invalid ${kind} factory map`);
    for (const [vendor, factory] of Object.entries(map)) {
      if (!vendor || ["__proto__", "constructor", "prototype"].includes(vendor) || typeof factory !== "function") throw new Error(`${record.packageName} has an invalid ${kind} factory for ${vendor}`);
      count++;
    }
  }
  if (!count) throw new Error(`${record.packageName} exports no model provider factories`);
  return value;
}

/** No discovery of siblings and no implicit defaults: add is the installation's selection. */
export function loadModelVendors(options: ModelVendorStoreOptions): ModelVendors {
  const refused = new Map<string, string[]>();
  const importModule = options.importModule ?? (entry => import(pathToFileURL(entry).href));
  async function loadOne(record: InstalledModelVendor): Promise<VendorFactories> {
    let current: ReturnType<typeof packageInfo>;
    try { current = packageInfo(record.path); }
    catch { throw new Error(`${record.packageName} is unavailable; npm install ${record.packageName}, then barry adapter model add <package-directory>`); }
    if (current.packageName !== record.packageName || current.contractVersion !== record.contractVersion || current.factoryExport !== record.factoryExport) throw new Error(`${record.packageName} changed its provider contract; run barry adapter model add ${record.path} again`);
    let loaded: unknown;
    try { loaded = await importModule(current.entry); }
    catch { throw new Error(`${record.packageName} could not load; reinstall with npm install ${record.packageName}`); }
    return factoriesOf(loaded, current);
  }
  function installed(): InstalledModelVendor[] {
    if (!existsSync(options.file)) return [];
    const records = z.array(registration).parse(JSON.parse(readFileSync(options.file, "utf8")));
    const names = new Set<string>();
    const paths = new Set<string>();
    for (const record of records) {
      if (names.has(record.packageName) || paths.has(record.path)) throw new Error(`${options.file} lists a model provider twice`);
      names.add(record.packageName); paths.add(record.path);
    }
    return records;
  }
  function save(records: InstalledModelVendor[]): void {
    mkdirSync(dirname(options.file), { recursive: true });
    const temp = `${options.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temp, options.file);
    } finally { rmSync(temp, { force: true }); }
  }
  return {
    installed,
    refused,
    async add(path, addOptions = {}) {
      const { entry: _entry, ...info } = packageInfo(resolve(path));
      const record = { ...info, ...addOptions };
      const own = await loadOne(record);
      const release = acquireLock(dirname(options.file), "model-providers");
      try {
        const records = installed();
        if (addOptions.shipped) {
          // Sharing only a name or only a directory makes a replacement, which stays the user's;
          // sharing both makes the shipped package itself, which setup adopts.
          const userSelection = records.find(other => !other.shipped && (other.packageName === record.packageName) !== (other.path === record.path));
          if (userSelection) return userSelection;
        }
        const others = records.filter(other => other.packageName !== record.packageName && other.path !== record.path);
        // Validate the settled set under the mutation lock before publishing a selection.
        let settled = own;
        // Stale selections stay recorded but must not block repairing the checkout.
        for (const other of others) {
          let factories: VendorFactories;
          try { factories = await loadOne(other); } catch { continue; }
          settled = mergeVendorFactories(settled, factories);
        }
        save([...others, record]);
        return record;
      } finally { release(); }
    },
    remove(packageName) {
      const release = acquireLock(dirname(options.file), "model-providers");
      try {
        const records = installed();
        if (!records.some(record => record.packageName === packageName)) return false;
        save(records.filter(record => record.packageName !== packageName));
        return true;
      } finally { release(); }
    },
    async load(packageNames) {
      refused.clear();
      const records = installed();
      const names = packageNames ?? records.map(record => record.packageName);
      if (new Set(names).size !== names.length) throw new Error("A model provider was selected twice");
      const chosen = names.map(name => {
        const record = records.find(record => record.packageName === name);
        if (!record) throw new Error(`${name} is not selected; npm install ${name}, then barry adapter model add <package-directory>`);
        return record;
      });
      let factories: VendorFactories = {};
      for (const record of chosen) {
        try { factories = mergeVendorFactories(factories, await loadOne(record)); }
        catch (error) { refused.set(record.packageName, [error instanceof Error ? error.message : "model provider is unavailable"]); }
      }
      return mergeVendorFactories(factories);
    },
  };
}
