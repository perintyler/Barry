/**
 * The opencode server client, its event mapping, and the environment that
 * fixes E6.
 *
 * The E6 tests are the point of this package. The bug is that the attaching
 * client's environment is IGNORED by the server it connects to, so config sent
 * to the wrong process looks applied and is not. That asymmetry cannot be seen
 * from either side alone, which is why it survived: the tests below assert the
 * two environments differ in exactly the way that matters.
 *
 * The live half — the real binary under these environments — is
 * `src/live/opencode-live.test.ts`.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { basicAuth, readServerEvents, OpenCodeServerClient } from "./client.js";
import {
  attachArgs,
  barryToolName,
  clientEnv,
  enabledProviders,
  openCodeEnv,
  openCodeHome,
  permissionRules,
  prepareRuntimeDir as makeRuntimeDir,
  providerKeys,
  serveArgs,
  sessionConfig,
} from "./launch-env.js";

/** Runtime dirs made here, removed after each test. */
const madeDirs: string[] = [];
function prepareRuntimeDir(): string {
  const dir = makeRuntimeDir();
  madeDirs.push(dir);
  return dir;
}

/** An SSE byte stream that delivers exactly these chunks. */
function chunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of madeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("authenticating to the server", () => {
  it("uses HTTP Basic as the user `opencode`", () => {
    // Bearer returns 401. The user is literally "opencode", not the session or
    // the human.
    const header = basicAuth("secret");
    expect(header.startsWith("Basic ")).toBe(true);
    expect(Buffer.from(header.slice(6), "base64").toString()).toBe("opencode:secret");
  });
});

describe("reading the event stream", () => {
  it("reads an event that arrives whole", async () => {
    const seen = [];
    for await (const event of readServerEvents(chunkedStream(['data: {"type":"a"}\n']))) {
      seen.push(event);
    }
    expect(seen).toEqual([{ type: "a" }]);
  });

  it("reads an event SPLIT ACROSS CHUNKS", async () => {
    // The failure this prevents: a reader that decodes each chunk and splits it
    // on newlines drops any event straddling a boundary, and drops it silently.
    // During the research that presented as a parser seeing no events at all
    // against a server that was streaming them.
    const seen = [];
    for await (const event of readServerEvents(chunkedStream(['data: {"ty', 'pe":"split"}\n']))) {
      seen.push(event);
    }
    expect(seen).toEqual([{ type: "split" }]);
  });

  it("reads several events delivered in one chunk", async () => {
    const seen = [];
    for await (const event of readServerEvents(
      chunkedStream(['data: {"type":"a"}\ndata: {"type":"b"}\n']),
    )) {
      seen.push(event);
    }
    expect(seen).toEqual([{ type: "a" }, { type: "b" }]);
  });

  it("skips a malformed frame instead of ending the stream", async () => {
    const seen = [];
    for await (const event of readServerEvents(
      chunkedStream(['data: not json\ndata: {"type":"after"}\n']),
    )) {
      seen.push(event);
    }
    expect(seen).toEqual([{ type: "after" }]);
  });

  it("ignores lines that are not data frames", async () => {
    const seen = [];
    for await (const event of readServerEvents(chunkedStream([': keepalive\n\ndata: {"type":"x"}\n']))) {
      seen.push(event);
    }
    expect(seen).toEqual([{ type: "x" }]);
  });
});

describe("E6: which process the config reaches", () => {
  it("does NOT put config on an attaching client's environment", () => {
    // Sending it there would imply it takes effect. It does not — and that
    // false implication is what made E6 invisible for a release.
    const env = clientEnv(prepareRuntimeDir(), "pw");

    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(env.OPENCODE_CONFIG).toBeUndefined();
  });

  it("gives each process a private runtime dir", () => {
    const a = prepareRuntimeDir();
    const b = prepareRuntimeDir();

    expect(a).not.toBe(b);
    expect(statSync(a).mode & 0o777).toBe(0o700);
  });
});

describe("the environment every opencode process runs in", () => {
  function homes(): string {
    const root = mkdtempSync(join(tmpdir(), "oc-homes-"));
    madeDirs.push(root);
    return root;
  }

  function envFor(identityEnv: Record<string, string | undefined> = {}, config: Record<string, unknown> = {}) {
    const home = openCodeHome("barry-session", homes());
    return { home, env: openCodeEnv({ home, runtimeDir: prepareRuntimeDir(), identityEnv, config }) };
  }

  it("hands the server a private config path rather than serialized secrets in its environment", () => {
    const config = { mcp: { servers: { probe: { headers: { Authorization: "Bearer synthetic-mcp-token" } } } } };
    const { env } = envFor({}, config);
    expect(env.OPENCODE_CONFIG).toEqual(expect.any(String));
    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(JSON.parse(readFileSync(env.OPENCODE_CONFIG, "utf8"))).toEqual(config);
    expect(statSync(env.OPENCODE_CONFIG).mode & 0o777).toBe(0o600);
    expect(statSync(env.XDG_RUNTIME_DIR).mode & 0o777).toBe(0o700);
    expect(JSON.stringify(env)).not.toContain("synthetic-mcp-token");
  });

  it("keeps opencode's data, state and config in the session's own home, not the user's", () => {
    // opencode reads a provider key from the credential store in its data dir
    // BEFORE the environment: on the user's data dir, a key they once saved
    // in opencode beat the identity's (verified on 2.0.24).
    const { home, env } = envFor();

    expect(env.XDG_DATA_HOME).toBe(home.data);
    expect(env.XDG_STATE_HOME).toBe(home.state);
    expect(env.XDG_CONFIG_HOME).toBe(home.config);
    for (const dir of [home.data, home.state, home.config]) expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("finds the same home for the same session, so its conversation resumes", () => {
    const root = homes();
    expect(openCodeHome("s1", root)).toEqual(openCodeHome("s1", root));
    expect(openCodeHome("s1", root).data).not.toBe(openCodeHome("s2", root).data);
  });

  it("switches off the repo's own config and the binary's self-update", () => {
    // A repo's opencode.json is loaded by default and can add MCP servers,
    // providers and permissions.
    const { env } = envFor();

    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
    expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe("1");
  });

  it("hands over the identity's keys under the names opencode reads, and never in config", () => {
    const { env } = envFor({ Z_AI_API_KEY: "zai-key", OPENROUTER_API_KEY: "or-key" }, { model: "zai/glm" });

    // opencode's `zai` reads ZHIPU_API_KEY; Barry declares Z_AI_API_KEY.
    expect(env.ZHIPU_API_KEY).toBe("zai-key");
    expect(env.OPENROUTER_API_KEY).toBe("or-key");
    // Config is the LAST place opencode looks for a key, and it is printed by
    // `opencode debug config`; it carries none.
    expect(readFileSync(env.OPENCODE_CONFIG, "utf8")).not.toContain("zai-key");
  });
});

describe("which providers a session may use", () => {
  it("enables the providers the identity holds a key for", () => {
    expect(providerKeys({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "", OPENROUTER_API_KEY: undefined }).providers).toEqual(["anthropic"]);
  });

  it("adds the session model's own provider, which may need no key", () => {
    expect(enabledProviders({ ANTHROPIC_API_KEY: "a" }, "ollama/llama3")).toEqual(["anthropic", "ollama"]);
    expect(enabledProviders({ ANTHROPIC_API_KEY: "a" }, "anthropic/claude")).toEqual(["anthropic"]);
  });

  it("enables none when the identity holds no key and names no model", () => {
    // An empty list denies every provider (verified on 2.0.24) — nothing found
    // in the ambient environment, such as Bedrock on AWS variables, gets in.
    expect(enabledProviders({ AWS_ACCESS_KEY_ID: "x" })).toEqual([]);
  });
});

describe("the config document", () => {
  it("is in 2.x's own shape, where an MCP server's codemode survives", () => {
    const config = sessionConfig({
      mcp: { barry: { type: "remote", url: "http://127.0.0.1:1/mcp", codemode: false } },
      permissions: [{ action: "*", resource: "*", effect: "deny" }],
      providers: ["openrouter"],
      model: "openrouter/openai/gpt-4o-mini",
    });

    expect(config).toEqual({
      model: "openrouter/openai/gpt-4o-mini",
      enabled_providers: ["openrouter"],
      permissions: [{ action: "*", resource: "*", effect: "deny" }],
      mcp: { servers: { barry: { type: "remote", url: "http://127.0.0.1:1/mcp", codemode: false } } },
      share: "disabled",
    });
  });
});

describe("the rules a session runs under", () => {
  it("denies every native action first, then lets the session's servers through", () => {
    expect(permissionRules(["barry"], [], [], "ask")).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      { action: "barry_*", resource: "*", effect: "ask" },
    ]);
    expect(permissionRules(["barry"], [], [], "allow")[1]).toEqual({ action: "barry_*", resource: "*", effect: "allow" });
  });

  it("names a server's tools as opencode does, hyphens kept", () => {
    // opencode writes `barry-tools_x`; a rule for `barry_tools_*` never matched.
    expect(permissionRules(["barry-tools"], [], [], "allow")[1]?.action).toBe("barry-tools_*");
  });

  it("denies each denied tool by opencode's name for it, after the rule that let it through", () => {
    // opencode applies the last rule that matches.
    const rules = permissionRules(["barry-tools"], ["mcp__barry_tools__run", "shell"], [], "allow");

    expect(rules.slice(2)).toEqual([
      { action: "barry-tools_run", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
    ]);
  });

  it("refuses a server name that would read as a wildcard", () => {
    expect(() => permissionRules(["bad*"], [], [], "allow")).toThrow(/wildcards/);
  });
});

describe("an action opencode asks about, in Barry's words", () => {
  it("names a server's tool as Barry does", () => {
    expect(barryToolName("barry_probe_tool", ["barry"])).toBe("mcp__barry__probe_tool");
    expect(barryToolName("barry-tools_run", ["barry-tools"])).toBe("mcp__barry-tools__run");
  });

  it("gives an action to the longest server it could belong to", () => {
    expect(barryToolName("a_b_x", ["a", "a_b"])).toBe("mcp__a_b__x");
  });

  it("leaves a native action as it is", () => {
    expect(barryToolName("shell", ["barry"])).toBe("shell");
    expect(barryToolName("barry_", ["barry"])).toBe("barry_");
  });
});

describe("launch arguments", () => {
  it("binds the server to loopback", () => {
    // An engine holding a session's whole conversation has no business
    // listening on a routable interface.
    expect(serveArgs(4096)).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "4096"]);
  });

  it("attaches the TUI to Barry's server and session", () => {
    expect(attachArgs("http://127.0.0.1:4096", "sess-1")).toEqual([
      "--server",
      "http://127.0.0.1:4096",
      "--session",
      "sess-1",
    ]);
  });
});

describe("the server client", () => {
  function clientWith(response: unknown, status = 200) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: status < 400,
      status,
      text: async () => JSON.stringify(response),
    });
    vi.stubGlobal("fetch", fetchMock);
    return { client: new OpenCodeServerClient({ baseUrl: "http://x", password: "pw" }), fetchMock };
  }

  it("sends the delivery mode through, so a steer is not silently a queue", async () => {
    const { client, fetchMock } = clientWith({});
    await client.prompt("s1", "hello", "steer");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ text: "hello", delivery: "steer" });
  });

  it("steers only when asked: a prompt with no delivery steers a running turn on 2.0.14", async () => {
    const { client, fetchMock } = clientWith({});
    await client.prompt("s1", "hello");

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ text: "hello" });
  });

  it("creates a session in its directory, on its model, under its rules", async () => {
    const { client, fetchMock } = clientWith({ data: { id: "ses_1" } });
    const id = await client.createSession({
      directory: "/repo",
      model: { providerID: "opencode", id: "m" },
      permissions: [{ action: "*", resource: "*", effect: "ask" }],
    });

    expect(id).toBe("ses_1");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      location: { directory: "/repo" },
      model: { providerID: "opencode", id: "m" },
      permissions: [{ action: "*", resource: "*", effect: "ask" }],
    });
  });

  it("reads each MCP server's state in the session's directory, as 2.0.24 lists them", async () => {
    const { client, fetchMock } = clientWith({
      location: { directory: "/repo" },
      data: [
        { name: "barry", status: { status: "connected" }, integrationID: "mcp_1" },
        { name: "dead", status: { status: "failed", error: "ConnectionRefused" }, integrationID: "mcp_2" },
        { name: "slow", status: { status: "pending" }, integrationID: "mcp_3" },
      ],
    });

    expect(await client.mcpStatus("/repo")).toEqual({ barry: "connected", dead: "failed", slow: "pending" });
    expect(fetchMock.mock.calls[0][0]).toBe("http://x/api/mcp?location%5Bdirectory%5D=%2Frepo");
  });

  it("reads the build the server is running", async () => {
    const { client } = clientWith({ version: "2.0.14" });
    expect(await client.version()).toBe("2.0.14");
  });

  it("carries the server's own explanation on a failure", async () => {
    // "HTTP 500" alone sends the reader to the server's logs; the body usually
    // says which field was wrong.
    const { client } = clientWith({ error: "bad session" }, 500);
    await expect(client.prompt("s1", "x", "queue")).rejects.toThrow(/bad session/);
  });
});

it.each(["ask", "allow"] as const)("grants native actions with %s using the last matching rule", effect => {
  const rules = permissionRules([], ["patch", "grep"], ["read", "grep", "glob", "edit", "write", "patch", "execute"], effect);
  const permission = (tool: string) => rules.filter(rule => rule.action === "*" || rule.action === (["write", "patch"].includes(tool) ? "edit" : tool)).at(-1)?.effect;
  expect(permission("read")).toBe(effect);
  expect(permission("glob")).toBe(effect);
  for (const name of ["grep", "edit", "write", "patch", "execute", "shell", "websearch"]) expect(permission(name)).toBe("deny");
});
