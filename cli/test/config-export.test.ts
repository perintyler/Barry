import { owner } from "@barry-rocks/identities-bag";
import { closeIdentitiesStore } from "@barry-rocks/identities-bag/testing";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWithEnv } from "./run-cli.js";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";

describe("barry config export/import", () => {
  let configDir: string;
  let storeDir: string;

  /**
   * These tests spawn the real CLI, and the child does NOT inherit a pinned
   * store: `cli/vitest.config.ts` deliberately does not extend the base config,
   * and `run-cli` only forwards `process.env`. Without this the child resolves
   * the developer's real ~/.barry/prod stores, `scratch-guard` refuses to
   * open them under VITEST, and every case here fails on exit 1 — which is what
   * it did. Pin scratch stores for the CHILD, not just this process.
   */
  const storeEnv = (): Record<string, string> => ({
    BARRY_IDENTITIES_DB: join(storeDir, "identities.db"),
    BARRY_CONFIG_DB: join(storeDir, "config.db"),
  });
  const run = (...args: string[]) => runWithEnv(storeEnv(), ...args);

  beforeAll(() => {
    configDir = mkdtempSync(join(tmpdir(), "barry-config-test-"));
    mkdirSync(configDir, { recursive: true });
    storeDir = mkdtempSync(join(tmpdir(), "barry-config-store-"));
    const previous = process.env.BARRY_IDENTITIES_DB;
    closeIdentitiesStore();
    process.env.BARRY_IDENTITIES_DB = join(storeDir, "identities.db");
    try { owner.installation().provision({ username: "Export fixture owner" }); }
    finally {
      closeIdentitiesStore();
      if (previous === undefined) delete process.env.BARRY_IDENTITIES_DB;
      else process.env.BARRY_IDENTITIES_DB = previous;
    }
  });

  afterAll(() => {
    if (configDir && existsSync(configDir)) {
      rmSync(configDir, { recursive: true, force: true });
    }
    if (storeDir && existsSync(storeDir)) {
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it("exports all config files", () => {
    const { stdout, exitCode } = run("config", "export", "--dir", configDir);
    expect(exitCode).toBe(0);

    expect(existsSync(join(configDir, "identities.yaml"))).toBe(true);
    expect(existsSync(join(configDir, "traits.yaml"))).toBe(true);
    expect(existsSync(join(configDir, "bounds.yaml"))).toBe(true);
    expect(existsSync(join(configDir, "settings.yaml"))).toBe(true);
  });

  it("exports identities.yaml with version 1", () => {
    const raw = readFileSync(join(configDir, "identities.yaml"), "utf-8");
    const config = yamlParse(raw);
    expect(config.version).toBe(1);
    expect(config.exported_at).toBeDefined();
    expect(Array.isArray(config.identities)).toBe(true);
  });

  it("exports traits.yaml as an array or comment", () => {
    const raw = readFileSync(join(configDir, "traits.yaml"), "utf-8");
    // Either a YAML array or a comment indicating no user-defined traits
    const parsed = yamlParse(raw);
    if (parsed !== null) {
      expect(Array.isArray(parsed)).toBe(true);
      for (const trait of parsed) {
        expect(trait.name).toBeDefined();
        expect(trait.access).toMatch(/^(read|readwrite)$/);
        expect(Array.isArray(trait.namespaces)).toBe(true);
      }
    }
  });

  it("imports exported config without error", () => {
    const { exitCode, stderr } = run("config", "import", "--dir", configDir);
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("Error:");
  });

  it("round-trips identities through export/import/export", () => {
    // Export again to a second dir and compare
    const configDir2 = mkdtempSync(join(tmpdir(), "barry-config-test2-"));
    try {
      const { exitCode } = run("config", "export", "--dir", configDir2);
      expect(exitCode).toBe(0);

      const raw1 = readFileSync(join(configDir, "identities.yaml"), "utf-8");
      const raw2 = readFileSync(join(configDir2, "identities.yaml"), "utf-8");
      const config1 = yamlParse(raw1);
      const config2 = yamlParse(raw2);

      // Same identities (ignore exported_at timestamp)
      expect(config2.version).toBe(config1.version);
      expect(config2.identities.length).toBe(config1.identities.length);
      for (let i = 0; i < config1.identities.length; i++) {
        expect(config2.identities[i].name).toBe(config1.identities[i].name);
      }
    } finally {
      rmSync(configDir2, { recursive: true, force: true });
    }
  });

  // An identity is a directory now: importing one that does not exist creates
  // it in Barry's identities folder, and importing it again changes that file.
  describe("importing identities", () => {
    const identityYaml = () =>
      yamlParse(readFileSync(join(process.env.BARRY_HOME!, "app-support", "identities", "imported", "identity.yaml"), "utf-8"));
    const importOne = (fields: Record<string, unknown>) => {
      const dir = mkdtempSync(join(tmpdir(), "barry-config-import-"));
      try {
        writeFileSync(join(dir, "identities.yaml"), yamlStringify({ version: 1, exported_at: "2026-01-01", identities: [{ name: "imported", ...fields }] }), "utf-8");
        return run("config", "import", "--dir", dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    it("creates a directory for an identity that does not exist, and reports a key it cannot import", () => {
      const { exitCode, stdout, stderr } = importOne({ adapters: { "claude-code": { model: "anthropic/claude-opus-5" } }, favourite_colour: "blue" });
      expect(exitCode, stderr).toBe(0);
      expect(identityYaml()).toMatchObject({ name: "imported", adapters: { "claude-code": { model: "anthropic/claude-opus-5" } } });
      expect(identityYaml()).not.toHaveProperty("favourite_colour");
      expect(`${stdout}${stderr}`).toContain(`Skipped for "imported" (no such identity setting): favourite_colour`);
    });

    it("updates the directory of an identity that exists", () => {
      const { exitCode, stderr } = importOne({ default_model: "qwen3:4b", default_model_provider: "ollama" });
      expect(exitCode, stderr).toBe(0);
      expect(identityYaml()).toMatchObject({ name: "imported", adapters: { "claude-code": { model: "ollama/qwen3:4b" } } });
    });
  });

  describe("version guard", () => {
    it("rejects identities.yaml with unsupported version", () => {
      const badDir = mkdtempSync(join(tmpdir(), "barry-config-bad-"));
      try {
        writeFileSync(
          join(badDir, "identities.yaml"),
          'version: 99\nexported_at: "2026-01-01"\nidentities: []\n',
          "utf-8",
        );
        const { exitCode, stderr } = run("config", "import", "--dir", badDir);
        expect(exitCode).not.toBe(0);
        expect(stderr).toContain("Unsupported identities.yaml format version");
      } finally {
        rmSync(badDir, { recursive: true, force: true });
      }
    });

    it("rejects identities.yaml with no version", () => {
      const badDir = mkdtempSync(join(tmpdir(), "barry-config-bad2-"));
      try {
        writeFileSync(
          join(badDir, "identities.yaml"),
          'exported_at: "2026-01-01"\nidentities: []\n',
          "utf-8",
        );
        const { exitCode, stderr } = run("config", "import", "--dir", badDir);
        expect(exitCode).not.toBe(0);
        expect(stderr).toContain("Unsupported identities.yaml format version");
      } finally {
        rmSync(badDir, { recursive: true, force: true });
      }
    });
  });
});
