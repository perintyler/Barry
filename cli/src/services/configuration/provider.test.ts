import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { describe, it, expect } from "vitest";
import { coreMigrations } from "./provider.js";

const scratch = () => mkdtempSync(join(tmpdir(), "barry-sql-history-"));

describe("the configuration store provider", () => {
  it("opens a bundled provider outside the source tree using the generated SQL catalog", async () => {
    const directory = scratch();
    const output = join(directory, "provider.mjs");
    symlinkSync(fileURLToPath(new URL("../../../node_modules", import.meta.url)), join(directory, "node_modules"), "dir");
    await build({ entryPoints: [fileURLToPath(new URL("./provider.ts", import.meta.url))], outfile: output, bundle: true, platform: "node", format: "esm", external: ["better-sqlite3"] });
    const bundled = await import(pathToFileURL(output).href);
    expect(bundled.coreMigrations).toEqual(coreMigrations);
    const handle = bundled.coreProvider.open(join(directory, "config.db"), { readonly: false });
    try { expect(handle.schemaVersion()).toBe(coreMigrations.length); } finally { handle.close(); }
  });
});
