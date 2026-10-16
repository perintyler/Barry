import ts from "typescript";
import { build } from "esbuild";
import { bundleBuildInfo } from "./build-info.mjs";
import { readFile, writeFile, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(cli, "..");
const outdir = resolve(cli, "dist");
const metadata = bundleBuildInfo(root);
// Stat the actual build inputs, including dirty sources. Fresh dirty builds
// remain usable; edits after the build invalidate them without spawning Git.
metadata.inputs = {};
async function watch(path) {
  const key = relative(root, path);
  if (Object.hasOwn(metadata.inputs, key)) return;
  const current = await stat(path);
  metadata.inputs[key] = `${current.mtimeMs}:${current.ctimeMs}:${current.size}`;
}
const checkedPackages = new Set();
async function watchPackages(path) {
  let directory = dirname(path);
  while (directory !== dirname(directory)) {
    if (checkedPackages.has(directory)) return;
    checkedPackages.add(directory);
    const file = resolve(directory, "package.json");
    if (existsSync(file)) await watch(file);
    directory = dirname(directory);
  }
}
await build({
  absWorkingDir: cli,
  entryPoints: { barry: "src/index.ts", identity: "src/identity.ts", "barry-hook": "src/hooks/hook-dispatch.ts" },
  outdir,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  treeShaking: true,
  chunkNames: "chunk-[hash]",
  external: ["better-sqlite3", "esbuild", "tsx", "tsx/*", "bufferutil", "utf-8-validate", "@barry-rocks/session-*", "@barry-rocks/completion-*", "@barry-rocks/decision-*", "@barry-rocks/embedding-*"],
  banner: { js: 'import { createRequire as __barryCreateRequire } from "node:module"; import { fileURLToPath as __barryFileURLToPath } from "node:url"; const require = __barryCreateRequire(import.meta.url);' },
  plugins: [{
    name: "preserve-module-assets",
    setup(build) {
      build.onLoad({ filter: /\.[cm]?[jt]s$/ }, async ({ path }) => {
        await watch(path);
        await watch(dirname(path));
        await watchPackages(path);
        // These packages locate shipped assets and subprocess entries beside
        // their original modules. Keep that location after code is inlined.
        if (!path.startsWith(root + "/") || path.includes("/node_modules/.pnpm/")) return;
        let contents = await readFile(path, "utf8");
        const asset = JSON.stringify(relative(outdir, path));
        const tree = ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true);
        const edits = [];
        function visit(node) {
          if (ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression) && node.expression.name.text === "meta") {
            if (node.name.text === "url") edits.push([node.getStart(tree), node.end, `new URL(${asset}, import.meta.url).href`]);
            else if (node.name.text === "dirname") edits.push([node.getStart(tree), node.end, `__barryFileURLToPath(new URL(${JSON.stringify(relative(outdir, dirname(path)) + "/")}, import.meta.url))`]);
          }
          ts.forEachChild(node, visit);
        }
        visit(tree);
        for (const [start, end, text] of edits.sort((a, b) => b[0] - a[0])) contents = contents.slice(0, start) + text + contents.slice(end);
        return { contents, loader: path.endsWith(".ts") ? "ts" : "js" };
      });
      build.onLoad({ filter: /\.json$/ }, async ({ path }) => { await watch(path); });
    },
  }],
  logLevel: "info",
});
// Resolution and JSON imports also affect the bundle. Watch package metadata
// and assets even though the source-transform plugin does not load them.
for (const path of ["package.json", "pnpm-lock.yaml", "cli/package.json", "cli/tsconfig.json", "sdk/package.json"]) await watch(resolve(root, path));
await writeFile(resolve(outdir, "build.json"), JSON.stringify(metadata, null, 2) + "\n");
