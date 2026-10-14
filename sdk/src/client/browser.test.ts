import { build } from "esbuild";
import { expect, it } from "vitest";

it("bundles the public client for browsers without Node or host modules", async () => {
  const result = await build({
    entryPoints: [new URL("../index.ts", import.meta.url).pathname, new URL("../apps/index.ts", import.meta.url).pathname, new URL("../routes/index.ts", import.meta.url).pathname],
    outdir: "browser-fixture",
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    metafile: true,
  });
  expect(result.outputFiles).toHaveLength(3);
  const inputs = Object.keys(result.metafile.inputs);
  // Host code (launchd, stores, the CLI) must stay out of a browser bundle.
  // `src/barry/` is the SDK surface itself and is browser-safe; the folder of
  // that name this once excluded held local host discovery and is gone.
  expect(inputs.some((path) => /src\/(services|stores|cli)\//.test(path))).toBe(false);
});
