import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createIdentityDirectory,
  loadIdentityFromDirectory as realLoadIdentityFromDirectory,
  registerIdentityDirectory,
} from "./identity-files.js";
import type { IdentityRecord } from "./identities.js";
import { getIdentitiesDir, getBuiltinIdentityDir } from "../paths.js";
import { defaultHarness, FALLBACK_HARNESS } from "@barry-rocks/sdk/internal/identities";

// POL-19: actorId is required; these inheritance reads are metadata-only.
function loadIdentityFromDirectory(dir: string, options: { actorId: number } = { actorId: 1 }): IdentityRecord {
  return realLoadIdentityFromDirectory(dir, options);
}

describe("identity inheritance", () => {
  it("keeps the base identity default equal to the SDK fallback", () => {
    expect(defaultHarness(loadIdentityFromDirectory(getBuiltinIdentityDir()!).metadata.adapters ?? {})).toBe(FALLBACK_HARNESS);
  });
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.BARRY_HOME;
    home = mkdtempSync(join(tmpdir(), "barry-inheritance-test-"));
    process.env.BARRY_HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.BARRY_HOME;
    else process.env.BARRY_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  function createIdentity(name: string, content: string): string {
    const identitiesDir = getIdentitiesDir();
    mkdirSync(identitiesDir, { recursive: true });
    const dir = join(identitiesDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "identity.yaml"), content, "utf-8");
    return dir;
  }

  it("inherits from the base identity when inherits: barry is specified", () => {
    const childDir = createIdentity(
      "my-agent",
      `
name: my-agent
inherits: barry
bags:
  - git
  - github
`,
    );

    const record = loadIdentityFromDirectory(childDir);
    expect(record.name).toBe("my-agent");
    expect(record.metadata.inherits).toBe("barry");
    // Child bags unioned with the base identity's bags
    expect(record.metadata.bags).toContain("actions");
    expect(record.metadata.bags).toContain("artifacts");
    expect(record.metadata.bags).toContain("bash");
    expect(record.metadata.bags).toContain("filesystem");
    expect(record.metadata.bags).toContain("sessions");
    expect(record.metadata.bags).toContain("git");
    expect(record.metadata.bags).toContain("github");
    // Inherited traits from the base identity
    expect(record.metadata.traits).toEqual(["artifacts", "bash", "filesystem", "instructions", "sessions"]);
    // Inherited defaults
    expect(record.metadata.bag_grant).toBe("session");
    expect(record.metadata.tool_discovery).toBe("provider");
  });

  it("inherits from the base identity when inherits: base is specified", () => {
    const childDir = createIdentity(
      "my-base-agent",
      `
name: my-base-agent
inherits: base
bags:
  - git
  - github
`,
    );

    const record = loadIdentityFromDirectory(childDir);
    expect(record.name).toBe("my-base-agent");
    expect(record.metadata.inherits).toBe("base");
    expect(record.metadata.bags).toContain("actions");
    expect(record.metadata.bags).toContain("artifacts");
    expect(record.metadata.bags).toContain("bash");
    expect(record.metadata.bags).toContain("git");
    expect(record.metadata.traits).toEqual(["artifacts", "bash", "filesystem", "instructions", "sessions"]);
  });

  it("unions child bags and traits with parent", () => {
    createIdentity(
      "parent-agent",
      `
name: parent-agent
bags: [actions, bash]
traits: [bash]
`,
    );

    const childDir = createIdentity(
      "child-agent",
      `
name: child-agent
inherits: parent-agent
bags: [filesystem, bash]
traits: [filesystem]
`,
    );

    const record = loadIdentityFromDirectory(childDir);
    expect(record.metadata.bags).toEqual(["actions", "bash", "filesystem"]);
    expect(record.metadata.traits).toEqual(["bash", "filesystem"]);
  });

  it("inherits secret references with child precedence", () => {
    const parentDir = createIdentity("parent-agent", "name: parent-agent\nsecrets:\n  SHARED_KEY:\n    in: .env\n  PARENT_ONLY:\n    in: .env\n");
    const childDir = createIdentity("child-agent", "name: child-agent\ninherits: parent-agent\nsecrets:\n  SHARED_KEY:\n    in: keychain\n    item: child-shared\n  CHILD_ONLY:\n    in: .env\n");
    const secrets = loadIdentityFromDirectory(childDir).metadata.secrets;
    expect(secrets?.SHARED_KEY.reference).toEqual({ in: "keychain", item: "child-shared" });
    expect(secrets?.PARENT_ONLY.directory).toBe(parentDir);
    expect(secrets?.CHILD_ONLY.directory).toBe(childDir);
  });

  it("inherits vault-backed secret declarations but not the vault they came from", () => {
    createIdentity("parent-agent", "name: parent-agent\nvault: parent-vault\nsecrets:\n  TOKEN:\n    in: vault\n    item: TOKEN\n    field: password\n");
    const withOwn = loadIdentityFromDirectory(createIdentity("child-agent", "name: child-agent\ninherits: parent-agent\nvault: child-vault\n"));
    expect(withOwn.metadata.vault).toBe("child-vault");
    expect(withOwn.metadata.secrets?.TOKEN.reference).toEqual({ in: "vault", item: "TOKEN", field: "password" });

    const withNone = loadIdentityFromDirectory(createIdentity("vaultless-agent", "name: vaultless-agent\ninherits: parent-agent\n"));
    expect(withNone.metadata.vault).toBeUndefined();
  });

  it("merges adapter fields and switches the inherited default", () => {
    createIdentity(
      "parent-agent",
      `
name: parent-agent
adapters:
  claude-code:
    model: claude-sonnet-4-6
    mode: guest
vault: parent-vault
`,
    );

    const childDir = createIdentity(
      "child-agent",
      `
name: child-agent
inherits: parent-agent
adapters:
  codex:
    default: true
    model: gpt-5.6-sol
vault: child-vault
`,
    );

    const record = loadIdentityFromDirectory(childDir);
    expect(record.metadata.adapters).toEqual({ "claude-code": { model: "claude-sonnet-4-6", mode: "guest" }, codex: { default: true, model: "gpt-5.6-sol" } });
    expect(record.metadata.vault).toBe("child-vault");
  });

  it("merges bounds cumulatively so child cannot drop parent security denials", () => {
    createIdentity(
      "parent-agent",
      `
name: parent-agent
bound:
  deniedTools: [Bash]
  deniedAccess: [write]
`,
    );

    const childDir = createIdentity(
      "child-agent",
      `
name: child-agent
inherits: parent-agent
bound:
  deniedTools: [Edit]
`,
    );

    const record = loadIdentityFromDirectory(childDir);
    const bound = record.metadata.bound;
    expect(bound?.deniedTools).toEqual(["Bash", "Edit"]);
    expect(bound?.deniedAccess).toEqual(["write"]);
  });

  it("rejects circular inheritance", () => {
    createIdentity(
      "agent-a",
      `
name: agent-a
inherits: agent-b
`,
    );

    const dirB = createIdentity(
      "agent-b",
      `
name: agent-b
inherits: agent-a
`,
    );

    expect(() => loadIdentityFromDirectory(dirB)).toThrow(/Circular inheritance detected/);
  });

  it("throws when parent identity is not found", () => {
    const dir = createIdentity(
      "orphan-agent",
      `
name: orphan-agent
inherits: nonexistent-parent
`,
    );

    expect(() => loadIdentityFromDirectory(dir)).toThrow(/Parent identity "nonexistent-parent" not found/);
  });

  it("createIdentityDirectory defaults to inherits: base", async () => {
    const { createIdentityDirectory } = await import("./identity-files.js");
    const testDir = join(getIdentitiesDir(), "default-barry-child");
    createIdentityDirectory("default-barry-child", { displayName: "Default Child" }, { dir: testDir });
    const record = loadIdentityFromDirectory(testDir);
    expect(record.metadata.inherits).toBe("base");
    expect(record.metadata.bags).toContain("artifacts");
  });

  it("rejects creating or registering user identity named barry or base", async () => {
    const { createIdentityDirectory, registerIdentityDirectory } = await import("./identity-files.js");
    expect(() => createIdentityDirectory("barry")).toThrow(/reserved/);
    expect(() => registerIdentityDirectory("barry", "/tmp/fake")).toThrow(/reserved/);
    expect(() => createIdentityDirectory("base")).toThrow(/reserved/);
    expect(() => registerIdentityDirectory("base", "/tmp/fake")).toThrow(/reserved/);
  });
});
