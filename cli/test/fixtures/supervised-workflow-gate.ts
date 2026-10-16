/** Trusted fixture preload: hold the actual worker before its readiness message. */
import assert from "node:assert/strict";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
const root = realpathSync(process.env.HOME!);
assert.equal(dirname(root), realpathSync(tmpdir()));
assert.match(basename(root), /^supervised-workflow-agent-[A-Za-z0-9]+$/);
writeFileSync(join(root, "bootstrap-wait.json"), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
while (!existsSync(join(root, "bootstrap-continue"))) await new Promise(resolve => setTimeout(resolve, 10));
