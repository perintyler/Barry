#!/usr/bin/env node
// `barry`: the command. An identity's own command runs this with
// `--identity-binding <json>` first, which binds the process to that identity.
// Checkouts and releases both ship TypeScript sources and run them through tsx.
import { existsSync } from "node:fs";

const checkoutRoot = new URL("../../", import.meta.url);
if (existsSync(new URL(".git", checkoutRoot)) &&
    existsSync(new URL("pnpm-workspace.yaml", checkoutRoot)) &&
    !existsSync(new URL("sdk/dist/index.js", checkoutRoot))) {
  process.stderr.write("barry: the packages are not built. Run: pnpm build:packages\n");
  process.exit(2);
}

const { register } = await import("tsx/esm/api");
register();
if (process.argv[2] === "--identity-binding") {
  process.argv.splice(2, 1);
  await import("../src/identity.ts");
} else {
  await import("../src/index.ts");
}
