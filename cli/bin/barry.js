#!/usr/bin/env node
// `barry`: the command. An identity's own command runs this with
// `--identity-binding <json>` first, which binds the process to that identity.
// Checkouts and releases both ship TypeScript sources and run them through tsx.
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareEntry } from "./entry.js";

if (process.env.BARRY_TIMING === "1") performance.mark("bin:start");

process.env.BARRY_CLI_ENTRY = fileURLToPath(import.meta.url);
const checkoutRoot = new URL("../../", import.meta.url);
if (existsSync(new URL(".git", checkoutRoot)) &&
    existsSync(new URL("pnpm-workspace.yaml", checkoutRoot)) &&
    !existsSync(new URL("sdk/dist/index.js", checkoutRoot))) {
  process.stderr.write("barry: the packages are not built. Run: pnpm build:packages\n");
  process.exit(2);
}

const identity = process.argv[2] === "--identity-binding";
const selected = await prepareEntry(fileURLToPath(checkoutRoot), identity ? "identity" : "barry");
if (identity) process.argv.splice(2, 1);
if (selected.entry === "bundle") await import(pathToFileURL(selected.path).href);
else {
  await import("../src/lib/timing.ts");
  await import(identity ? "../src/identity.ts" : "../src/index.ts");
}
