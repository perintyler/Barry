/**
 * The check goes red on each shape it exists to catch, and stays green on the
 * shapes it deliberately allows. Each case plants a file and names it
 * explicitly, so a check that silently scanned nothing would fail here too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHECK = join(import.meta.dirname, "service-addresses.mjs");
const dir = mkdtempSync(join(tmpdir(), "service-addresses-"));

function run(source, { entry = false } = {}) {
  const file = join(dir, `planted-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(file, source);
  const args = entry ? ["--entry", file, file] : [file];
  return spawnSync(process.execPath, [CHECK, ...args], { encoding: "utf8" });
}

test("a literal loopback address fails", () => {
  const r = run(`const url = "http://127.0.0.1:4885/api";\n`);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /literal address/);
});

test("an address captured at module load fails", () => {
  const r = run(`import { getServiceUrl } from "x";\nconst API = getServiceUrl("api");\n`);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /captured at load/);
});

test("a service entry calling .listen( itself fails", () => {
  const r = run(`server.listen(4885, "127.0.0.1");\n`, { entry: true });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /direct \.listen\(/);
});

test("a lookup at call time, a vendor's own port and a non-entry listen pass", () => {
  const r = run(
    `const api = () => getServiceUrl("api");\n` +
      `const ollama = process.env.BARRY_OLLAMA_URL || "http://127.0.0.1:11434";\n` +
      `probe.listen(0, "127.0.0.1");\n`,
  );
  assert.equal(r.status, 0, r.stderr);
});
