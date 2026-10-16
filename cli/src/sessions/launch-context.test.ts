/**
 * The launch-context steps, exercised in-process — no child session is spawned.
 *
 * `resolveLaunchContext` used to be one function whose only observable surface
 * was a running agent, so none of its logic could be checked without a launch.
 * These are the four data-returning steps it was split into (plus the two pure
 * helpers that feed them). The oracle, where one applies, is the recorded
 * launch plan the golden tests pin (`__golden__/start-launch-*.json`): the
 * session id and MCP server set those plans carry are what these steps must
 * reproduce, so a drift here is a drift the goldens would also show.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveNativeTools } from "@barry-rocks/sdk/bounds";
import type { InstalledAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import {
  resolveSessionNativeTools,
  buildMcpConfig,
  preCreateSession,
  preCreateRequestBody,
  buildLaunchEnv,
  launchProvenanceEnv,
} from "./launch-context.js";

// Load the shipped adapters the way `barry start` loads them — from a store in
// a BARRY_HOME that is never the developer's own. (Same setup launch-parity
// uses, so this exercises the real claude record the goldens were cut against.)
const savedHome = process.env.BARRY_HOME;
const savedAllowEmpty = process.env.BARRY_CONFIG_ALLOW_EMPTY;
const home = mkdtempSync(join(tmpdir(), "barry-launch-context-"));
let claude: InstalledAdapter;
beforeAll(async () => {
  process.env.BARRY_HOME = home;
  process.env.BARRY_CONFIG_ALLOW_EMPTY = "1";
  const { resetAdapterStore } = await import("../adapters/installed.js");
  resetAdapterStore();
  const { adapterStore } = await import("../adapters/installed.js");
  const { adapters } = await adapterStore();
  await adapters.add(fileURLToPath(new URL("../../../adapters/sessions/claude/", import.meta.url)));
  claude = adapters.installed().find((record) => record.id === "claude-code")!;
});
afterAll(async () => {
  const { resetAdapterStore } = await import("../adapters/installed.js");
  if (savedAllowEmpty === undefined) delete process.env.BARRY_CONFIG_ALLOW_EMPTY;
  else process.env.BARRY_CONFIG_ALLOW_EMPTY = savedAllowEmpty;
  if (savedHome === undefined) delete process.env.BARRY_HOME;
  else process.env.BARRY_HOME = savedHome;
  resetAdapterStore();
  rmSync(home, { recursive: true, force: true });
});

/** The recorded launch plan the goldens pin, used as the oracle below. */
function goldenPlan(harness: string, variant: string): { env: Record<string, string>; args: string[] } {
  const golden = JSON.parse(
    readFileSync(new URL(`../commands/__golden__/start-launch-${harness}.json`, import.meta.url), "utf8"),
  );
  return golden[variant].plan;
}

describe("resolveSessionNativeTools", () => {
  it("derives the native tool selection from resolved bounds and tools, matching resolveNativeTools", async () => {
    const { Barry } = await import("@barry-rocks/sdk");
    const { identities, resolve } = await import("@barry-rocks/identities-bag");
    Barry.use(identities);
    try {
      for (const [bounds, expectedAllowed] of [
        [[{ tools: { deny: ["*:Bash", "*:Write", "*:Edit", "*:NotebookEdit", "*:WebFetch", "*:WebSearch"] } }], ["Read", "Glob", "Grep"]],
        [[{ tools: { deny: ["*:Read", "*:Glob", "*:Grep", "*:Write", "*:Edit", "*:NotebookEdit", "*:WebFetch", "*:WebSearch"] } }], ["Bash"]],
        [[], ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "NotebookEdit", "WebFetch", "WebSearch"]],
      ] as const) {
        const bound = await resolve.bound(undefined, { bounds: [...bounds] });
        const tools = await resolve.tools(undefined, {
          harness: claude.id,
          mode: "guest",
          defaults: false,
          bounds: [...bounds],
        });
        const result = resolveSessionNativeTools({ bound, tools }, claude, "guest");
        const direct = resolveNativeTools(bound, tools, claude, "guest");
        expect(result.native).toEqual(direct);
        expect(result.allowedNativeTools).toEqual(direct.allowed);
        expect(result.deniedTools).toEqual(direct.denied);
        expect(result.allowedNativeTools).toEqual([...expectedAllowed]);
      }
    } finally {
      Barry.reset();
    }
  });
});

describe("buildMcpConfig", () => {
  it("materializes a config to a temp dir and round-trips its servers", () => {
    const scratch = mkdtempSync(join(tmpdir(), "barry-mcp-artifact-"));
    try {
      const config = { mcpServers: { barry: { type: "http" as const, url: "http://127.0.0.1:4510/mcp?sessionId=s" } } };
      const artifact = buildMcpConfig(config, scratch);
      // The dir is under the root the caller gave, so cleanup removes exactly it.
      expect(artifact.tmpDir.startsWith(scratch)).toBe(true);
      expect(artifact.mcpConfigPath).toBe(join(artifact.tmpDir, "mcp.json"));
      // The servers it reports are the servers it wrote — a harness that reads
      // the file and one that takes `mcpServers` directly must see the same set.
      expect(artifact.mcpServers).toEqual(config.mcpServers);
      expect(JSON.parse(readFileSync(artifact.mcpConfigPath, "utf8"))).toEqual(config);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("preCreateSession", () => {
  const input = {
    sessionId: "sess-1",
    cwd: "/repo",
    source: "cli",
    identityId: 7,
    bags: ["linear", "slack"],
    selectedBounds: ["readonly"],
    harness: "claude-code",
    directive: null as string | null,
    name: "my session",
  };

  it("builds the request body the sessions API contract names", () => {
    expect(preCreateRequestBody(input)).toEqual({
      sessionId: "sess-1",
      cwd: "/repo",
      source: "cli",
      directive: null,
      name: "my session",
      identityId: 7,
      bags: ["linear", "slack"],
      bounds: ["readonly"],
      provider: "claude-code",
    });
  });

  it("reports success without touching the real API", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response("", { status: 200 });
    };

    const result = await preCreateSession(input, {
      fetch: fakeFetch,
      endpoint: "http://localhost:9/api/v1/sessions/start",
      headers: { "Content-Type": "application/json" },
    });
    expect(result.ok).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual(preCreateRequestBody(input));
  });

  it("reports a rejected pre-create as data, never throwing", async () => {
    const fakeFetch: typeof fetch = async () => new Response("forbidden", { status: 403 });
    const result = await preCreateSession(input, {
      fetch: fakeFetch,
      endpoint: "http://localhost:9/api/v1/sessions/start",
      headers: {},
    });
    expect(result.ok).toBe(false);
    expect(result.warning).toContain("HTTP 403");
    expect(result.warning).toContain("forbidden");
  });

  it("reports a thrown fetch as data, never throwing", async () => {
    const fakeFetch: typeof fetch = async () => {
      throw new Error("offline");
    };
    const result = await preCreateSession(input, {
      fetch: fakeFetch,
      endpoint: "http://localhost:9/api/v1/sessions/start",
      headers: {},
    });
    expect(result.ok).toBe(false);
    expect(result.warning).toContain("offline");
  });
});

it("bounds a transport that ignores AbortSignal and names the API port", async () => {
  const started = performance.now();
  const result = await preCreateSession({ sessionId: "timeout", cwd: "/tmp", source: "cli", identityId: 1, selectedBounds: [], harness: "claude" }, {
    fetch: (() => new Promise(() => {})) as typeof fetch,
    endpoint: "http://localhost:4854/api/v1/sessions/start", headers: {}, timeoutMs: 20,
  });
  expect(result.ok).toBe(false);
  expect(result.warning).toContain("within 0.02 s at http://localhost:4854");
  expect(result.warning).toContain("barry status / barry up");
  expect(performance.now() - started).toBeLessThan(500);
});

describe("buildLaunchEnv", () => {
  it("prepends the hook bin, carries the session id, and strips declared credentials", () => {
    const env = buildLaunchEnv({
      baseEnv: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ambient", KEEP: "1" },
      cliBin: "/hooks/.bin",
      sessionId: "sess-xyz",
      directive: "do the thing",
      identityId: 42,
      stripCredentialNames: ["ANTHROPIC_API_KEY"],
    });
    expect(env.PATH).toBe("/hooks/.bin:/usr/bin");
    expect(env.BARRY_SESSION_ID).toBe("sess-xyz");
    expect(env.BARRY_DIRECTIVE).toBe("do the thing");
    expect(env.BARRY_ID).toBe("42");
    // The ambient provider key must not reach the harness; the unrelated var must.
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.KEEP).toBe("1");
  });

  it("is a clone — it never mutates the base env", () => {
    const base: Record<string, string | undefined> = { PATH: "/usr/bin" };
    buildLaunchEnv({ baseEnv: base, cliBin: "/b", sessionId: "s", directive: null, identityId: null, stripCredentialNames: [] });
    expect(base).toEqual({ PATH: "/usr/bin" });
  });

  it("omits the optional keys when their inputs are empty", () => {
    const env = buildLaunchEnv({
      baseEnv: {},
      cliBin: "/b",
      sessionId: "s",
      directive: null,
      identityId: null,
      stripCredentialNames: [],
    });
    expect("BARRY_DIRECTIVE" in env).toBe(false);
    expect("BARRY_ID" in env).toBe(false);
  });

  it("reproduces the BARRY_SESSION_ID the golden launch plan carries", () => {
    // Oracle: the recorded claude plan runs with this session id in its env;
    // the step that builds the child env must put the same value there.
    const plan = goldenPlan("claude", "default");
    const env = buildLaunchEnv({
      baseEnv: { PATH: plan.env.PATH },
      cliBin: "/hooks/.bin",
      sessionId: plan.env.BARRY_SESSION_ID,
      directive: null,
      identityId: null,
      stripCredentialNames: [],
    });
    expect(env.BARRY_SESSION_ID).toBe(plan.env.BARRY_SESSION_ID);
  });
});

describe("launchProvenanceEnv", () => {
  it("always pins harness and mode, and model only when set", () => {
    expect(launchProvenanceEnv({ harness: "claude", mode: "guest" })).toEqual({
      BARRY_PROVIDER: "claude",
      BARRY_MODE: "guest",
    });
    expect(launchProvenanceEnv({ harness: "claude", mode: "guest", model: "claude-opus-5", modelProvider: "zai" })).toEqual({
      BARRY_PROVIDER: "claude",
      BARRY_MODE: "guest",
      BARRY_MODEL: "claude-opus-5",
      BARRY_MODEL_PROVIDER: "zai",
    });
  });
});
