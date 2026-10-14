// Bundles the vault's server into one file so the LaunchDaemon can run it
// without pointing at anything the invoking user owns.
//
// Everything else in this bag runs unbundled — Barry's own MCP server loads
// bag tools straight from TypeScript (see the README's bag primitive). The vault service is
// the one exception: it runs as `_barryvault`, and `pnpm exec tsx
// server/src/index.ts` against this checkout would mean the process root owns
// is executing code `tyler` can edit at will — the isolation `user:` exists to
// provide would be decorative. A single bundled file that gets installed
// root-owned, not writable by the invoking user, is what actually closes that
// (see README.md).
import { build } from "esbuild";
import { cpSync, mkdirSync, existsSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

await build({
  entryPoints: ["server/src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist/server.mjs",
  // Native module — cannot be bundled, must ship (and be rebuilt) alongside.
  external: ["better-sqlite3"],
  banner: {
    // CJS compat for require() in an ESM bundle — express and some transitive
    // deps still reach for it at load time. Deliberately NOT also injecting
    // __dirname here: app.ts derives its own via
    // dirname(fileURLToPath(import.meta.url)) at the source level, and esbuild
    // bundles that untouched — a banner-injected __dirname collides with it
    // ("Identifier '__dirname' has already been declared"), caught by actually
    // running the bundle rather than trusting it because the build exited 0.
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
});

// The UI is read from disk at request time (see server/src/app.ts), not
// bundled as a string — ship it as a sibling file so that lookup still finds
// it relative to the installed location.
if (!existsSync("dist/src/ui")) mkdirSync("dist/src/ui", { recursive: true });
cpSync("src/ui/app.html", "dist/src/ui/app.html");

const require = createRequire(import.meta.url);
const sqlite = require.resolve("better-sqlite3/package.json");
const nativeRequire = createRequire(sqlite);
// prebuild-install is an install-time downloader; the built native module is
// already present in better-sqlite3/build and is the only runtime artifact needed.
for (const name of ["better-sqlite3", "bindings", "file-uri-to-path"]) {
  const source = realpathSync(dirname(nativeRequire.resolve(`${name}/package.json`)));
  const target = join("dist/node_modules", name);
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true, dereference: true });
}
console.log("Built dist/server.mjs (+ UI and native dependencies)");
