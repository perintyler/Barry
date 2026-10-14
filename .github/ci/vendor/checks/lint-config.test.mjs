import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const { ESLint } = createRequire(resolve("package.json"))("eslint");

const eslint = new ESLint();

/**
 * `calculateConfigForFile` happily computes config for paths that do not exist,
 * so a renamed file leaves this suite passing while it verifies nothing. Two
 * paths had already gone stale that way. Assert existence first.
 */
async function rulesFor(file) {
  assert.ok(existsSync(file), `${file} should exist — update this test when files move`);
  const config = await eslint.calculateConfigForFile(file);
  assert.ok(config, `${file} should have an ESLint configuration`);
  return config.rules;
}

function severity(rule) {
  return Array.isArray(rule) ? rule[0] : rule;
}

test("owned runtime areas receive correctness rules", async () => {
  for (const file of [
    "bags/sessions/hooks/change-tracker/index.ts",
    // Was engine/secrets/src/index.ts until the sdk fold (4c5a4a554), then
    // sdk/lib/src/credentials/index.ts until the sdk was flattened.
    "sdk/src/auth/credentials.ts",
    // Was bags/artifacts/src/artifacts/mcp/server.ts until that bag moved out
    // to ~/repos/bags/artifacts, bags/reminders/src/store.ts until that one
    // followed, and bags/system/src/executor.ts until the system bag was
    // dissolved and its shell tooling became bags/bash. The list only needs
    // real files in owned runtime areas — ESLint resolves config by path, so a
    // path that no longer exists fails the lookup rather than reporting a rule
    // problem.
    "bags/bash/src/executor.ts",
    "bags/memory/src/tools.ts",
    "bags/sessions/api/src/index.ts",
  ]) {
    const rules = await rulesFor(file);
    // Syntax rules only. Barry dropped the type-aware rules (no-floating-promises,
    // no-unnecessary-type-assertion) in October 2026: lint runs the recommended
    // presets without a TypeScript program, and `pnpm -r typecheck` runs as its
    // own step. Asserting them here failed every lint run once they were gone.
    assert.equal(severity(rules["@typescript-eslint/no-unused-vars"]), 2, file);
    assert.equal(severity(rules["@typescript-eslint/no-explicit-any"]), 2, file);
  }
});

test("double assertions through `unknown` stay banned", async () => {
  // sdk/src/bags/registry.ts was sdk/bag-host/src/registry.ts until e4316bd8e,
  // then sdk/lib/src/host/registry.ts until the sdk was flattened.
  for (const file of ["bags/sessions/api/src/index.ts", "sdk/src/bags/registry.ts"]) {
    const rules = await rulesFor(file);
    const restricted = rules["no-restricted-syntax"];
    assert.equal(severity(restricted), 2, file);
    const selectors = restricted.slice(1).map((entry) => entry.selector);
    assert.ok(
      selectors.includes("TSAsExpression > TSAsExpression > TSUnknownKeyword"),
      `${file} should ban \`x as unknown as T\``,
    );
  }
});

test("runtime environments keep their console policies separate", async () => {
  const cliRules = await rulesFor("cli/src/index.ts");
  const serverRules = await rulesFor("bags/sessions/api/src/index.ts");
  assert.equal(severity(cliRules["no-console"]), 0);
  assert.equal(severity(serverRules["no-console"]), 2);
});

// No Svelte half any more: barry.works was the only first-party Svelte source
// and it lives in its own bag repo now, so the svelte/* overrides have nothing
// in this checkout to assert against.
test("tests receive their intended overrides", async () => {
  const testRules = await rulesFor("bags/mcp/src/bag-proxy.test.ts");
  assert.equal(severity(testRules["@typescript-eslint/no-unused-vars"]), 0);
  // Relaxing unused variables must not relax the rest: tests keep the same
  // ban on explicit `any` as the code they test.
  assert.equal(severity(testRules["@typescript-eslint/no-explicit-any"]), 2);
});

// The generated contract client left with the old sdk/contracts tree; the
// generated store migrations are what remains under a generated/ directory.
test("generated code remains ignored", async () => {
  const file = "sdk/src/workflows/generated/migrations.ts";
  assert.ok(existsSync(file), `${file} should exist — update this test when files move`);
  assert.equal(await eslint.isPathIgnored(file), true);
});
