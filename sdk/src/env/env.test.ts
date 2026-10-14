import { describe, expect, it } from "vitest";
import {
  asEnvironmentVariable,
  EnvDefinitionError,
  exposedEnv,
  getEnvironmentVariable,
  readEnvironment,
  type EnvironmentVariable,
} from "./index.js";
import { identityEnvironment } from "./identity.js";
import {
  assertSessionCredentials,
  CredentialNotResolved,
  declaredCredentialEnvs,
  requiredCredentials,
} from "./gate.js";
import { openVault } from "../vault/account.js";

function vaultSessionOf(items: Record<string, { password?: string; username?: string }>) {
  return {
    async getItem(name: string) {
      const item = items[name];
      if (!item) throw Object.assign(new Error(`Vault item "${name}" not found`), { name: "VaultItemNotFoundError" });
      return {
        id: "1",
        name,
        username: item.username ?? null,
        password: item.password ?? null,
        uri: null,
        notes: null,
      };
    },
    async putItem() {},
    async deleteItem() {},
    async listItems() {
      return [];
    },
    async searchItems() {
      return [];
    },
    async close() {},
    email: "e@x",
    serverUrl: "unix://test",
  };
}

describe("getEnvironmentVariable — the precedence, as a lookup", () => {
  const identity = { A: { source: "value", value: "identity" } };
  const manifest = {
    A: { source: "vault", item: "a", field: "password" },
    B: { source: "vault", item: "b", field: "password" },
  };

  it("the identity's definition wins", () => {
    expect(getEnvironmentVariable("A", { identity, manifest })).toEqual({ source: "value", value: "identity" });
  });

  it("the manifest default applies when the identity names nothing", () => {
    expect(getEnvironmentVariable("B", { identity, manifest })).toMatchObject({ source: "vault", item: "b" });
  });

  it("undefined when neither defines it — and the gate reads that as refusal", () => {
    expect(getEnvironmentVariable("C", { identity, manifest })).toBeUndefined();
  });

  it("a malformed definition names the variable, on either layer", () => {
    expect(() => getEnvironmentVariable("X", { identity: { X: { source: "wat" } } })).toThrow(EnvDefinitionError);
    expect(() => getEnvironmentVariable("X", { identity: {}, manifest: { X: { source: "wat" } } })).toThrow(EnvDefinitionError);
  });
});

describe("readEnvironment", () => {
  it("reads values and records where each came from", async () => {
    const env = await readEnvironment(undefined, {
      identity: {
        INLINE: { source: "value", value: "x" },
        FROM_FILE: { source: "file", name: "FROM_FILE" },
      },
      file: { FROM_FILE: "file-value" },
    });
    expect(env.vars).toEqual({ INLINE: "x", FROM_FILE: "file-value" });
    expect(env.sources).toEqual({ INLINE: "value", FROM_FILE: "file" });
  });

  it("reads the named manifest default through the vault", async () => {
    const vault = vaultSessionOf({ "openai-api-key": { password: "sk-test" } });
    const env = await readEnvironment(["OPENAI_API_KEY"], {
      identity: {},
      manifest: { OPENAI_API_KEY: { source: "vault", item: "openai-api-key", field: "password" } },
      vault,
    });
    expect(env.vars.OPENAI_API_KEY).toBe("sk-test");
    expect(env.sources.OPENAI_API_KEY).toBe("vault");
  });

  it("throws naming the variable when the vault item is absent", async () => {
    const vault = vaultSessionOf({});
    await expect(
      readEnvironment(["OPENAI_API_KEY"], {
        identity: { OPENAI_API_KEY: { source: "vault", item: "nope", field: "password" } },
        vault,
      }),
    ).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it("throws when a vault-sourced variable has no vault session", async () => {
    await expect(
      readEnvironment(["K"], { identity: { K: { source: "vault", item: "k", field: "password" } } }),
    ).rejects.toThrow(/no vault session/);
  });

  it("throws when a file-sourced entry is absent from the identity's .env", async () => {
    await expect(
      readEnvironment(["K"], { identity: { K: { source: "file", name: "K" } }, file: {} }),
    ).rejects.toThrow(/absent or empty/);
  });
});

describe("identityEnvironment", () => {
  it("returns no credentials for an explicitly empty binding set", async () => {
    expect((await identityEnvironment({ bags: [], secrets: {} })).vars).toEqual({});
  });
  it("refuses an unresolved identity instead of reading legacy inline values", async () => {
    await expect(identityEnvironment({ bags: [], env: { TOKEN: "legacy-inline" }, env_file: { TOKEN: "legacy-cached" } } as never))
      .rejects.toThrow("resolved identity must provide secret bindings");
  });
  it("fails on a declared vault reference without vault access", async () => {
    await expect(identityEnvironment({ bags: [], secrets: { K: { reference: { in: "vault", item: "k", field: "password" } } } }))
      .rejects.toThrow("$K: could not read declared vault secret");
  });
});

describe("exposedEnv", () => {
  it("only definitions that say expose: env reach the process env", () => {
    const definitions = {
      TOOL_SCOPED: { source: "value", value: "t" } as EnvironmentVariable,
      IN_ENV: { source: "value", value: "e", expose: "env" } as EnvironmentVariable,
    };
    const env = { vars: { TOOL_SCOPED: "t", IN_ENV: "e" }, sources: {} };
    expect(exposedEnv(definitions, env)).toEqual({ IN_ENV: "e" });
  });
});

describe("openVault under test", () => {
  it("refuses to touch the production vault from a test", async () => {
    await expect(openVault("personal")).rejects.toThrow(/refuses to open a real vault under VITEST/);
  });
});

describe("the session gate", () => {
  const harness = { id: "claude-code", credentials: { ANTHROPIC_API_KEY: { source: "vault", item: "anthropic-api-key", field: "password" } } };

  it("requires every manifest credential, and a routed vendor's env credential", () => {
    const required = requiredCredentials({
      harness,
      routedVendors: [
        { id: "zai", label: "z.ai", credential: { env: "Z_AI_API_KEY", item: "z-ai-api-key" } },
        { id: "ollama", credential: { placeholder: "ollama-local" } },
      ],
    });
    expect(required).toEqual([
      { env: "ANTHROPIC_API_KEY", requiredBy: "harness claude-code" },
      { env: "Z_AI_API_KEY", requiredBy: "vendor z.ai (routed)" },
    ]);
  });

  it("passes when every required credential has a declared source", () => {
    const { strip } = assertSessionCredentials({
      required: requiredCredentials({ harness }),
      env: { vars: { ANTHROPIC_API_KEY: "k" }, sources: { ANTHROPIC_API_KEY: "vault" } },
      ambientEnv: { ANTHROPIC_API_KEY: "k" },
      credentialEnvs: new Set(["ANTHROPIC_API_KEY"]),
    });
    expect(strip).toEqual([]);
  });

  it("refuses, naming the fix, when a required credential has no definition", () => {
    expect(() =>
      assertSessionCredentials({
        required: requiredCredentials({ harness }),
        env: { vars: {}, sources: {} },
        ambientEnv: { ANTHROPIC_API_KEY: "from-the-shell" },
        credentialEnvs: new Set(["ANTHROPIC_API_KEY"]),
      }),
    ).toThrow(CredentialNotResolved);
  });

  it("strips an ambient value for a credential the identity did not supply", () => {
    const { strip } = assertSessionCredentials({
      required: [],
      env: { vars: {}, sources: {} },
      ambientEnv: { OPENAI_API_KEY: "ambient" },
      credentialEnvs: new Set(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]),
    });
    expect(strip).toEqual(["OPENAI_API_KEY"]);
  });

  it("collects the denylist from vendor rows and harness manifests", () => {
    const envs = declaredCredentialEnvs({
      vendors: [
        { credential: { env: "Z_AI_API_KEY", item: "z" } },
        { credential: { placeholder: "ollama-local" } },
        { credential: null },
      ],
      harnessManifests: [harness.credentials, undefined],
    });
    expect(envs).toEqual(new Set(["Z_AI_API_KEY", "ANTHROPIC_API_KEY"]));
  });
});

describe("asEnvironmentVariable", () => {
  it("keeps expose: env, drops anything else it does not know", () => {
    expect(asEnvironmentVariable("A", { source: "value", value: "v", expose: "env" })).toEqual({
      source: "value",
      value: "v",
      expose: "env",
    });
  });

  it("normalizes bare string, number, and boolean scalars as inline values", () => {
    expect(asEnvironmentVariable("SENTRY_ORG", "vantage-sh")).toEqual({
      source: "value",
      value: "vantage-sh",
    });
    expect(asEnvironmentVariable("PORT", 3862)).toEqual({
      source: "value",
      value: "3862",
    });
    expect(asEnvironmentVariable("DEBUG", true)).toEqual({
      source: "value",
      value: "true",
    });
  });

  it("normalizes value definitions with numeric or boolean values", () => {
    expect(asEnvironmentVariable("PORT", { source: "value", value: 8080 })).toEqual({
      source: "value",
      value: "8080",
    });
  });

  it("rejects non-scalar, non-object definitions", () => {
    expect(() => asEnvironmentVariable("ARR", ["a"])).toThrow(/definition must be an object/);
    expect(() => asEnvironmentVariable("NIL", null)).toThrow(/definition must be an object/);
  });
});
