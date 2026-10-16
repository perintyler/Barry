/**
 * Tests for `barry bag check`.
 *
 * Real directories, not fs mocks: the subject is filesystem and schema work,
 * so a mocked fs would test the mock's shape instead of the check's. Each case
 * builds a throwaway bag under tmp, runs the command function directly (the
 * same unit-level choice bag-doctor.test.ts makes), and reads process.exitCode.
 *
 * The negative controls delete or break the exact thing a green run passed on,
 * because a passing run is also what a check that never looks would produce.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { bagCheckCommand } from "../src/commands/bag-check.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SDK_LIB = join(REPO_ROOT, "sdk");


let bagDir: string;

beforeEach(() => {
  bagDir = mkdtempSync(join(tmpdir(), "bag-check-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  rmSync(bagDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = 0;
});

/** Write files relative to the bag root, creating parent directories. */
function write(files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(bagDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

async function run(options: { deep?: boolean; json?: boolean } = {}): Promise<string[]> {
  const logged: string[] = [];
  const log = vi.mocked(console.log);
  const err = vi.mocked(console.error);
  log.mockImplementation((...args: unknown[]) => logged.push(args.join(" ")));
  err.mockImplementation((...args: unknown[]) => logged.push(args.join(" ")));
  try {
    await bagCheckCommand(bagDir, options);
  } finally {
    log.mockImplementation(() => {});
    err.mockImplementation(() => {});
  }
  return logged;
}

function outputIncludes(lines: string[], pattern: RegExp): boolean {
  return lines.some((l) => pattern.test(l));
}

describe("static checks", () => {
  it("passes a minimal bag", async () => {
    write({ "bag.yaml": "name: tiny\ndescription: smallest valid bag\n" });
    await run();
    expect(process.exitCode).toBe(0);
  });

  it("fails a directory with no bag.yaml", async () => {
    await run();
    expect(process.exitCode).toBe(1);
  });

  it("fails invalid YAML and says so", async () => {
    write({ "bag.yaml": "name: [unclosed\n" });
    const lines = await run();
    expect(process.exitCode).toBe(1);
    expect(outputIncludes(lines, /invalid YAML/)).toBe(true);
  });

  it("fails an unknown manifest key, and says the manifest may be newer than this barry", async () => {
    write({ "bag.yaml": "name: x\ndescription: d\nfrobnicate: true\n" });
    const lines = await run();
    expect(process.exitCode).toBe(1);
    expect(outputIncludes(lines, /Unrecognized key/)).toBe(true);
    expect(outputIncludes(lines, /newer barry/)).toBe(true);
  });

  it("passes while a hook script exists and fails once it is gone", async () => {
    write({
      "bag.yaml": "name: x\ndescription: d\nhooks:\n  agent:\n    - event: session-start\n      run: hooks/on-start.ts\n",
      "hooks/on-start.ts": "export default () => {};\n",
    });
    await run();
    expect(process.exitCode).toBe(0);

    rmSync(join(bagDir, "hooks/on-start.ts"));
    await run();
    expect(process.exitCode).toBe(1);
  });

  it("fails a script whose slash-command is a missing bag path, but not a bare executable", async () => {
    write({
      "bag.yaml":
        "name: x\ndescription: d\nscripts:\n  broken:\n    description: d\n    command: bin/missing.sh\n  fine:\n    description: d\n    command: bash\n    args: [\"-c\", \"true\"]\n",
    });
    const lines = await run();
    expect(process.exitCode).toBe(1);
    expect(outputIncludes(lines, /bin\/missing\.sh/)).toBe(true);
    expect(outputIncludes(lines, /command: bash/)).toBe(false);
  });

  it("reads an absolute command as itself, not as bag-relative", async () => {
    // coffee's services declare /bin/bash; joining it to the bag dir reported
    // the system shell missing — a false positive on every mac.
    write({
      "bag.yaml":
        "name: x\ndescription: d\nscripts:\n  system-shell:\n    description: d\n    command: /bin/bash\n  missing-absolute:\n    description: d\n    command: /no/such/binary\n",
    });
    const lines = await run();
    expect(process.exitCode).toBe(1);
    expect(outputIncludes(lines, /command "\/no\/such\/binary" does not exist/)).toBe(true);
    expect(outputIncludes(lines, /\/bin\/bash/)).toBe(false);
  });

  it("passes valid { allow, deny } bounds and fails unrecognized bound keys", async () => {
    write({
      "bag.yaml":
        "name: x\ndescription: d\nbounds:\n  readonly:\n    description: read-only\n    tools:\n      deny: [\"x:write\"]\n",
    });
    await run();
    expect(process.exitCode).toBe(0);

    write({
      "bag.yaml":
        "name: x\ndescription: d\nbounds:\n  broken:\n    unknownDimension: true\n",
    });
    const lines = await run();
    expect(process.exitCode).toBe(1);
    expect(outputIncludes(lines, /Unrecognized key/)).toBe(true);
  });

  it("fails an unloadable skill directory", async () => {
    write({
      "bag.yaml": "name: x\ndescription: d\n",
      "skills/broken/README.md": "no SKILL.md here\n",
    });
    const lines = await run();
    expect(process.exitCode).toBe(1);
    expect(outputIncludes(lines, /skill broken/)).toBe(true);
  });

  it("fails a schedule ref to an action the bag does not ship", async () => {
    write({
      "bag.yaml":
        "name: x\ndescription: d\nschedules:\n  nightly:\n    every: 1m\n    action: missing-action\n",
    });
    const lines = await run();
    expect(process.exitCode).toBe(1);
    expect(outputIncludes(lines, /refs action "missing-action"/)).toBe(true);
  });

  it("passes jobs whose code and action exist, and fails once they do not", async () => {
    write({
      "bag.yaml":
        "name: x\ndescription: d\njobs:\n  sweep:\n    runs:\n      using: node\n      main: src/sweep.ts\n"
        + "  triage:\n    runs:\n      using: action\n      action: triage\n",
      "src/sweep.ts": "",
      "actions/triage/action.yaml": "name: triage\ndescription: Triage a failure\ncontext: none\nprompt: Look\n",
    });
    await run();
    expect(process.exitCode).toBe(0);

    rmSync(join(bagDir, "src/sweep.ts"));
    write({ "actions/triage/action.yaml": "name: triage\ndescription: Triage a failure\nprompt: Look\n" });
    const lines = await run();
    expect(process.exitCode).toBe(1);
    expect(outputIncludes(lines, /job sweep runs "src\/sweep.ts", which does not exist/)).toBe(true);
    expect(outputIncludes(lines, /job triage runs action "triage", which needs a calling conversation/)).toBe(true);
  });

  it("rejects retired duplicate tool metadata", async () => {
    write({
      "bag.yaml":
        "name: x\ndescription: d\ntool-metadata:\n  - toolName: real\n    namespace: n\n    access: read\n",
      "src/tools.ts": "export {};\n",
    });
    const lines = await run();
    expect(process.exitCode).toBe(1);
    expect(outputIncludes(lines, /tool-metadata.*gone/)).toBe(true);
  });

  it("rejects a visibility override whose code declares no matching tool", async () => {
    write({ "bag.yaml": "name: x\ndescription: d\ntools:\n  - hidden_tool: deferred\n", "src/tools.ts": "export {};\n" });
    const lines = await run({ deep: true });
    expect(process.exitCode).toBe(1);
  });

  it("emits JSON when asked", async () => {
    write({ "bag.yaml": "name: x\ndescription: d\nhooks:\n  agent:\n    - event: session-start\n      run: gone.ts\n" });
    const lines = await run({ json: true });
    const json = lines.find((l) => l.startsWith("{"));
    expect(json).toBeDefined();
    expect(JSON.parse(json!)).toMatchObject({ ok: false });
    expect(process.exitCode).toBe(1);
  });
});

/**
 * The deep tests boot a real tools entry, which needs the bag to resolve
 * @barry-rocks/sdk and zod — neither is published from this checkout, so both
 * are symlinked from sdk's own node_modules, the same shape a workspace
 * install produces.
 */
describe("deep check", () => {
  function makeBootableBag(): void {
    const nm = join(bagDir, "node_modules", "@barry-rocks");
    mkdirSync(nm, { recursive: true });
    symlinkSync(SDK_LIB, join(nm, "sdk"));
    symlinkSync(join(SDK_LIB, "node_modules", "zod"), join(bagDir, "node_modules", "zod"));
    write({ "package.json": JSON.stringify({ name: "deep-fixture", type: "module" }) });
  }

  it("registers the tools a healthy entry exports", { timeout: 120_000 }, async () => {
    makeBootableBag();
    write({
      "bag.yaml":
        'name: deep-ok\ndescription: d\n',
      "src/tools.ts": `import { z } from "zod";
import { defineTool } from "@barry-rocks/sdk/tools";
export const probe = defineTool({
  name: "probe",
  namespace: "deep",
  access: "read",
  description: "probe",
  schema: {},
  handler: async () => "ok",
});
`,
    });
    const lines = await run({ deep: true });
    expect(process.exitCode).toBe(0);
    expect(outputIncludes(lines, /registered 1 tools: probe/)).toBe(true);
  });

  it("static passes what deep fails: an entry that throws on import", { timeout: 120_000 }, async () => {
    makeBootableBag();
    write({
      "bag.yaml": "name: deep-broken\ndescription: d\n",
      "src/tools.ts": 'import "no-such-package-anywhere";\n',
    });
    await run();
    expect(process.exitCode).toBe(0);
    const lines = await run({ deep: true });
    expect(process.exitCode).toBe(1);
    expect(outputIncludes(lines, /tools entry does not boot/)).toBe(true);
  });
});
