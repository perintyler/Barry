/**
 * The four harnesses Barry ships are adapters like any other: each passes the
 * checks a third party's would, and installs and loads from its directory
 * through the same loader `barry adapter add <path>` uses.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { checkAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import { loadAdapters } from "@barry-rocks/sdk/internal/adapters";

const ADAPTERS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../adapters/sessions");
/** `instrumented`/`guest`: whether the mode is declared. */
const SHIPPED = [
  { dir: "antigravity", id: "antigravity", instrumented: true, guest: true },
  { dir: "claude", id: "claude-code", instrumented: true, guest: true },
  { dir: "codex", id: "codex", instrumented: true, guest: true },
  { dir: "cursor", id: "cursor", instrumented: true, guest: true },
  { dir: "opencode", id: "opencode", instrumented: false, guest: true },
  { dir: "pi", id: "pi", instrumented: false, guest: false },
];

const home = mkdtempSync(join(tmpdir(), "barry-shipped-adapters-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const adapters = loadAdapters({ file: join(home, "adapters.json") });

describe.each(SHIPPED)("the shipped $dir adapter", ({ dir, id, instrumented, guest }) => {
  it("installs from its directory and records what it declares", async () => {
    const record = await adapters.add(join(ADAPTERS_DIR, dir));
    expect(record).toMatchObject({ id, path: join(ADAPTERS_DIR, dir), defaultMode: "hosted" });
    expect(record.modes.guest !== null).toBe(guest);
    expect(record.modes.hosted).not.toBeNull();
    expect(record.modes.instrumented !== null).toBe(instrumented);
  });

  it("passes every check a third party's adapter must", async () => {
    const entry = adapters.installed().find((a) => a.id === id);
    const adapter = await adapters.load(id);
    const { problems, checked } = checkAdapter(adapter, { bagManifest: entry?.bag?.manifest });
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(15);
  });
});
