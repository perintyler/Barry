import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import Database from "better-sqlite3";
import { withStoreContext } from "@barry-rocks/sdk/internal/stores";
import { setIdentityStore } from "@barry-rocks/sdk/internal/env";
import { bindSecretReferences } from "@barry-rocks/sdk/internal/identities";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDb, closeDb } from "./db.js";
import { runScriptAction } from "./execute-script.js";
import { type ScriptAction } from "@barry-rocks/sdk/internal/actions";

let dir: string;
let logRoot: string;

beforeEach(() => {
  setDb(new Database(":memory:"));
  dir = mkdtempSync(join(tmpdir(), "script-action-"));
  logRoot = mkdtempSync(join(tmpdir(), "script-action-logs-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
  rmSync(logRoot, { recursive: true, force: true });
});

afterAll(() => closeDb());

/** A script action whose body is `script` (bash), written into the action dir. */
function scriptAction(script: string, overrides: Partial<ScriptAction> = {}): ScriptAction {
  writeFileSync(join(dir, "run.sh"), script);
  return {
    source: "bag",
    name: "probe",
    bag: "ops",
    qualifiedName: "ops:probe",
    dir,
    description: "d",
    run: { command: "bash", args: ["run.sh"] },
    requires: { tools: [], secrets: [], bins: [] },
    instructions: [],
    steps: [],
    slashCommand: false,
    scripts: [],
    context: "none",
    legacySkill: false,
    bagAccess: "enabled",
    shadowed: false,
    ...overrides,
  };
}

const run = (action: ScriptAction, inputs?: Record<string, unknown>) =>
  runScriptAction(action, { trigger: "cli", logRoot, ...(inputs ? { inputs } : {}) });

describe("runScriptAction", () => {
  it("injects only declared installation secrets and ignores shell and extra overrides", async () => {
    vi.stubEnv("BARRY_HOME", dir);
    mkdirSync(join(dir, "config"));
    mkdirSync(join(dir, "app-support"));
    writeFileSync(join(dir, "config", "barry.yaml"), "secrets:\n  ACTION_TEST_KEY: {in: .env}\n");
    writeFileSync(join(dir, "app-support", "env"), "ACTION_TEST_KEY=installation-selected\nOTHER_TEST_KEY=not-selected\n");
    vi.stubEnv("ACTION_TEST_KEY", "ambient-wrong");
    const action = scriptAction('printf "%s|%s" "$ACTION_TEST_KEY" "${OTHER_TEST_KEY-unset}"', { secrets: ["ACTION_TEST_KEY"] });
    const { run: result } = await runScriptAction(action, { trigger: "cli", logRoot, secretScope: { kind: "installation" }, extraEnv: { ACTION_TEST_KEY: "override-wrong" } });
    expect(result.status).toBe("complete");
    expect(result.output).toBe("installation-selected|unset");
  });

  it("uses the selected identity file and never falls back to installation or shell values", async () => {
    writeFileSync(join(dir, ".env"), "ACTION_TEST_KEY=identity-selected\nOTHER_TEST_KEY=not-selected\n");
    setIdentityStore({
      get: async id => id === 7 ? { id } : undefined,
      resolveConfig: () => ({ bags: [], secrets: bindSecretReferences({ ACTION_TEST_KEY: { in: ".env" } }, dir) }),
      touchLastUsed: async () => {},
    });
    vi.stubEnv("ACTION_TEST_KEY", "ambient-wrong");
    const action = scriptAction('printf "%s|%s" "$ACTION_TEST_KEY" "${OTHER_TEST_KEY-unset}"', { secrets: ["ACTION_TEST_KEY"] });
    const selected = await runScriptAction(action, { trigger: "cli", logRoot, secretScope: { kind: "identity", id: 7 } });
    expect(selected.run.output).toBe("identity-selected|unset");
    const missing = await runScriptAction(action, { trigger: "cli", logRoot, secretScope: { kind: "identity", id: 99 } });
    expect(missing.run.status).toBe("failed");
    expect(missing.run.summary).toContain("declared action secrets are unavailable");
    expect(missing.run.output).toBeNull();
  });

  it("refuses ownerless secrets and sanitizes backend failures", async () => {
    const action = scriptAction("echo should-not-run", { secrets: ["ACTION_TEST_KEY"] });
    const noOwner = await runScriptAction(action, { trigger: "cli", logRoot, secretScope: { kind: "none" } });
    expect(noOwner.run.status).toBe("failed");
    expect(noOwner.run.output).toBeNull();
    setIdentityStore({ get: async () => { throw new Error("backend-private-canary"); }, resolveConfig: () => ({ bags: [], secrets: {} }), touchLastUsed: async () => {} });
    const failure = await runScriptAction(action, { trigger: "cli", logRoot, secretScope: { kind: "identity", id: 7 } });
    expect(failure.run.status).toBe("failed");
    expect(failure.run.summary).not.toContain("backend-private-canary");
  });

  it("runs an entry directly with literal argv and records its result", async () => {
    writeFileSync(join(dir, "entry.mjs"), "console.log(JSON.stringify(process.argv.slice(2)));");
    const action = scriptAction("unused", { run: { entry: "entry.mjs", command: "node", args: ["", "$(printf unexpected)"] } });
    const { run: recorded } = await runScriptAction(action, { trigger: "cli", logRoot, baseEnv: { PATH: "/missing" } });
    expect(recorded.status).toBe("complete");
    expect(recorded.process?.exit_code).toBe(0);
    expect(JSON.parse(recorded.output!)).toEqual(["", "$(printf unexpected)"]);
  });
  it("records a zero exit as complete, with the process and stdout tail", async () => {
    const { run: r } = await run(scriptAction("echo working; echo done"));
    expect(r.status).toBe("complete");
    expect(r.trigger).toBe("cli");
    expect(r.process?.exit_code).toBe(0);
    expect(r.output).toBe("working\ndone");
    expect(r.output_type).toBe("text");
    expect(readFileSync(r.process!.log_path!, "utf8")).toContain("working");
  });

  it("logs an extension's run under one bag segment, beside its parent's", async () => {
    const { run: r } = await run(scriptAction("echo embedded", { bag: "sessions/search", name: "schedule/embed", qualifiedName: "sessions/search:schedule/embed" }));
    expect(r.status).toBe("complete");
    expect(r.process?.log_path).toBe(join(logRoot, "sessions+search", "schedule", "embed", `${r.id}.log`));
    expect(readFileSync(r.process!.log_path!, "utf8")).toContain("embedded");
  });

  it("records a non-zero exit as failed, naming the code and last line", async () => {
    const { run: r } = await run(scriptAction("echo 'disk full'; exit 3"));
    expect(r.status).toBe("failed");
    expect(r.process?.exit_code).toBe(3);
    expect(r.summary).toMatch(/exited 3 — disk full/);
  });

  it("takes a failure's last line from stderr too, where scripts say why", async () => {
    const { run: r } = await run(scriptAction("echo progress; echo 'token expired' >&2; exit 1"));
    expect(r.summary).toMatch(/exited 1 — token expired/);
  });

  it("keeps a stderr failure when stdout reports progress afterward", async () => {
    const { run: r } = await run(scriptAction("echo 'token expired' >&2; echo progress; exit 1"));
    expect(r.summary).toMatch(/exited 1 — token expired/);
  });

  it("hands inputs to the script on stdin and in the environment", async () => {
    const action = scriptAction('read -r line; echo "stdin=$line env=$BARRY_ACTION_INPUTS"', {
      inputSchema: { type: "object", properties: { n: { type: "number" } } },
    });
    const { run: r } = await run(action, { n: 7 });
    expect(r.output).toBe('stdin={"n":7} env={"n":7}');
  });

  it("refuses invalid inputs before any run exists", async () => {
    const action = scriptAction("true", {
      inputSchema: { type: "object", properties: { n: { type: "number" } }, additionalProperties: false },
    });
    await expect(run(action, { n: "seven" })).rejects.toThrow();
  });

  it("stores schema-valid stdout as json output", async () => {
    const action = scriptAction(`echo '{"bytes": 42}'`, {
      outputSchema: { type: "object", properties: { bytes: { type: "number" } }, required: ["bytes"] },
    });
    const { run: r } = await run(action);
    expect(r.status).toBe("complete");
    expect(r.output_type).toBe("json");
    expect(JSON.parse(r.output!)).toEqual({ bytes: 42 });
  });

  it("fails a zero exit whose stdout breaks the declared output_schema", async () => {
    const action = scriptAction(`echo '{"bytes": "lots"}'`, {
      outputSchema: { type: "object", properties: { bytes: { type: "number" } }, required: ["bytes"] },
    });
    const { run: r } = await run(action);
    expect(r.status).toBe("failed");
    expect(r.summary).toMatch(/Exited 0 but output does not conform/);
    expect(r.output).toBeNull();
  });

  it("kills a run that outlives its timeout, children included, and says so", async () => {
    const marker = join(dir, "child-survived");
    const action = scriptAction(`(sleep 3; touch ${marker}) & sleep 30`, { timeout: 1 });
    const started = Date.now();
    const { run: r, timedOut } = await run(action);
    expect(timedOut).toBe(true);
    expect(r.status).toBe("failed");
    expect(r.summary).toMatch(/Timed out after 1s/);
    expect(Date.now() - started).toBeLessThan(10_000);
    // The backgrounded child was in the killed process group.
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    expect(() => readFileSync(marker)).toThrow();
  }, 15_000);

  it("does not pass unrelated shell credentials to the child process", async () => {
    vi.stubEnv("ACTION_PRIVATE_CANARY", "private-shell-value");
    const action = scriptAction('printf "%s" "${ACTION_PRIVATE_CANARY-unset}"');
    const { run: result } = await run(action);
    expect(result.status).toBe("complete");
    expect(result.output).toBe("unset");
  });

  it("filters an explicitly supplied base environment before adding declared values", async () => {
    const action = scriptAction('printf "%s:%s" "${ACTION_PRIVATE_CANARY-unset}" "$MODE"', { env: [{ name: "MODE", source: "value", value: "test" }] });
    const { run: result } = await runScriptAction(action, { trigger: "cli", logRoot, baseEnv: { PATH: process.env.PATH, ACTION_PRIVATE_CANARY: "private-base-value" } });
    expect(result.status).toBe("complete");
    expect(result.output).toBe("unset:test");
  });

  it("preserves empty and shell-looking literal values exactly", async () => {
    const action = scriptAction('printf "%s|%s" "$LITERAL" "$EMPTY"', { env: [
      { name: "LITERAL", source: "value", value: "$HOME/$(echo surprise)" },
      { name: "EMPTY", source: "value", value: "" },
    ] });
    expect((await run(action)).run.output).toBe("$HOME/$(echo surprise)|");
  });

  it("records a missing command as a failed start, not a crash", async () => {
    const action = scriptAction("true", { run: { command: "barry-no-such-binary-xyz", args: [] } });
    const { run: r } = await run(action);
    expect(r.status).toBe("failed");
    expect(r.summary).toMatch(/Could not start barry-no-such-binary-xyz/);
  });

  it("runs validate: after a zero exit and fails the run when it does not hold", async () => {
    const action = scriptAction("true", { validate: { files_exist: ["report.txt"] } });
    const { run: r } = await run(action);
    expect(r.status).toBe("failed");
    expect(r.validation_failures?.[0]).toMatch(/report.txt/);
  });

  it("executes an extensionless script directly", async () => {
    writeFileSync(join(dir, "report"), "#!/bin/sh\necho direct\n");
    chmodSync(join(dir, "report"), 0o755);
    const action = scriptAction("", { run: { command: "./report", args: [] } });
    const { run: r } = await run(action);
    expect(r.output).toBe("direct");
  });
});

it.each([
  { traits: [], bound: null, allowedToolIds: ["filesystem:Read"] },
  { traits: [], bound: { files: { allowOnly: ["/tmp/**"] } }, allowedToolIds: ["bash:Bash"] },
])("refuses a raw script before child side effects under a restricted caller policy", async execution => {
  const marker = join(dir, "started");
  const action = scriptAction(`touch '${marker}'`);
  const result = await withStoreContext({ execution }, () => runScriptAction(action, { trigger: "session", logRoot }));
  expect(result.run.status).toBe("failed");
  expect(result.run.summary).toContain("execution policy");
  expect(() => readFileSync(marker)).toThrow();
});
it("refuses session-origin scripts when caller policy is absent", async () => {
  const result = await runScriptAction(scriptAction("echo unsafe"), { trigger: "session", logRoot });
  expect(result.run.status).toBe("failed");
  expect(result.run.summary).toContain("execution policy");
});
it("runs a real child with an explicit unbounded Bash grant", async () => {
  const result = await withStoreContext({ execution: { traits: [], bound: null, allowedToolIds: ["bash:Bash"] } },
    () => runScriptAction(scriptAction("echo permitted"), { trigger: "session", logRoot }));
  expect(result.run.status).toBe("complete");
  expect(readFileSync(result.run.process!.log_path!, "utf8")).toContain("permitted");
});
