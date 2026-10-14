import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import type BetterSqlite3 from "better-sqlite3";
import { discoverBuiltinBags } from "@barry-rocks/sdk/internal/bags";
import { parseManifest } from "@barry-rocks/sdk/bags";
import { loadSqlMigrations } from "@barry-rocks/sdk/internal/stores";
import { tsxLoaderUrl } from "@barry-rocks/sdk/internal/services";
import { managedStoreRegistry } from "../commands/db-stores.js";
import { coreProvider } from "../services/configuration/index.js";
import { nodeRuntime, runtimeTarball, sha256 } from "../services/runtime.js";
import { releaseRoot } from "./release.js";

export interface Probe {
  node: { version: string; sha256: string };
  stores: Record<string, number>;
  problems: string[];
}
function exportedEntries(value: unknown): string[] {
  if (typeof value === "string") return value.endsWith(".d.ts") ? [] : [value];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => key === "types" ? [] : exportedEntries(child));
}
function adapterEntries(root: string): string[] {
  const entries: string[] = [];
  const visit = (dir: string) => {
    if (existsSync(join(dir, "package.json"))) {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { exports?: unknown; main?: string };
      entries.push(...exportedEntries(pkg.exports ?? pkg.main).map(path => resolve(dir, path)));
    }
    for (const child of readdirSync(dir, { withFileTypes: true })) {
      if (child.isDirectory() && !["node_modules", "dist"].includes(child.name) && !child.name.startsWith(".")) visit(join(dir, child.name));
    }
  };
  visit(join(root, "adapters"));
  return entries;
}

export async function probeRelease(root = releaseRoot()): Promise<Probe> {
  const runtime = nodeRuntime("arm64");
  const report: Probe = { node: { version: runtime.version, sha256: runtime.sha256 }, stores: {}, problems: [] };
  const check = async (name: string, action: () => void | Promise<void>) => {
    try { await action(); } catch (error) { report.problems.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  await check("runtime", () => {
    if (realpathSync(process.execPath) !== realpathSync(join(root, "runtime/bin/node"))) throw new Error("probe is not running the shipped Node");
    if (process.version !== `v${runtime.version}`) throw new Error("running Node differs from pin");
    const tarball = join(root, "runtime", `${runtime.name}.tar.gz`);
    if (runtimeTarball(runtime, root) !== tarball || sha256(readFileSync(tarball)) !== runtime.sha256) throw new Error("shipped tarball differs from pin");
  });
  for (const directory of [join(root, "cli"), join(root, "bags/vault/dist")]) {
    await check(`better-sqlite3 from ${relative(root, directory)}`, () => {
      const require = createRequire(join(directory, "probe.cjs"));
      const Database: typeof BetterSqlite3 = require("better-sqlite3");
      const db = new Database(":memory:");
      try { if ((db.prepare("select 1 AS value").get() as { value: number } | undefined)?.value !== 1) throw new Error("select 1 failed"); } finally { db.close(); }
    });
  }
  await check("esbuild", async () => { await esbuild.transform("const value: number = 1", { loader: "ts" }); });
  const entries = readdirSync(join(root, "cli/bin")).filter(name => name.endsWith(".js")).map(name => join(root, "cli/bin", name));
  await check("bags", () => {
    const builtin = discoverBuiltinBags(join(root, "bags"));
    for (const name of ["mcp", "identities", "sessions"]) if (!(name in builtin.local)) throw new Error(`missing builtin ${name}`);
    for (const [name, path] of Object.entries(builtin.local)) {
      const bag = join(root, "bags", path);
      const manifest = parseManifest(bag);
      if (!manifest) throw new Error(`${name} has no manifest`);
      if (manifest.toolsEntry) entries.push(resolve(bag, manifest.toolsEntry.entry));
      for (const hook of [...(manifest.hooks ?? []), ...(manifest.barryHooks ?? [])]) entries.push(resolve(bag, hook.run));
      for (const service of Object.values(manifest.services)) {
        if (!service.entry) continue;
        const entry = resolve(bag, service.entry);
        entries.push(entry);
        if ([".ts", ".mts", ".cts", ".tsx"].includes(extname(entry))) {
          const loader = realpathSync(fileURLToPath(tsxLoaderUrl(dirname(entry))));
          const rel = relative(root, loader);
          if (rel.startsWith(`..${sep}`) || !rel.split(sep).includes("node_modules")) throw new Error(`${name}: tsx resolves outside release`);
        }
      }
    }
  });
  await check("stores", async () => {
    const home = process.env.BARRY_HOME;
    if (!home) throw new Error("probe requires a scratch BARRY_HOME");
    mkdirSync(home, { recursive: true });
    const { registry, warning } = await managedStoreRegistry("release-check", join(home, "stores"));
    if (warning) throw new Error(warning);
    const builtin = discoverBuiltinBags(join(root, "bags"));
    for (const { bag, store, declaration } of registry.declarationsFor()) {
      const count = bag === "core" ? coreProvider.migrations.length : loadSqlMigrations(join(root, "bags", builtin.local[bag]), declaration.migrations).length;
      const handle = await registry.open({ node: "release-check", ...(declaration.owned_by === "identity" ? { identity: "release-check" } : {}), bag, store });
      try {
        if (handle.schemaVersion() !== count) throw new Error(`${bag}/${store} did not reach migration ${count}`);
        report.stores[`${bag}/${store}`] = count;
      } finally { handle.close(); }
    }
  });
  await check("adapter entries", () => { entries.push(...adapterEntries(root)); });
  await check("imports", async () => { report.problems.push(...await checkImports(root, entries)); });
  return report;
}

/** One graph walk shares resolution across the CLI, bags, hooks and adapters. */
export async function checkImports(root: string, entries: string[]): Promise<string[]> {
  const physicalRoot = realpathSync(root);
  try {
    await esbuild.build({
      entryPoints: [...new Set(entries)], outdir: join(root, "imports"), outbase: root,
      bundle: true, write: false, platform: "node", format: "esm", logLevel: "silent",
      plugins: [{ name: "release-imports", setup(build) {
        build.onResolve({ filter: /^[^./]/ }, async (args) => {
          if (args.pluginData || isBuiltin(args.path)) return;
          const resolved = await build.resolve(args.path, { importer: args.importer, resolveDir: args.resolveDir, kind: args.kind, pluginData: true });
          if (resolved.errors.length || !resolved.path) return;
          const path = realpathSync(resolved.path);
          const rel = relative(physicalRoot, path);
          const workspace = !rel.startsWith(`..${sep}`) && !rel.split(sep).includes("node_modules");
          return workspace ? { path } : { path: args.path, external: true };
        });
      } }],
    });
    return [];
  } catch (error) {
    const failure = error as esbuild.BuildFailure;
    if (!failure.errors) throw error;
    return failure.errors.map(({ text, location }) => `${location ? `${location.file}:${location.line}: ` : ""}${text}`);
  }
}
