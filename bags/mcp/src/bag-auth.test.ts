import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Controls for the mocked child_process.spawn, execFile, and OAuth token cache.
const h = vi.hoisted(() => ({
  hasTokens: false,
  children: [] as Array<{ kill: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }>,
  execFileResults: new Map<string, number>(), // command → exit code
}));

// One mock per subpath the subject imports. A single vi.mock of the
// "@barry-rocks/sdk/bags" root is a SILENT no-op now that the subject reaches
// modules directly — it would never match and the suite would exercise the
// real module.
vi.mock("@barry-rocks/sdk/internal/vault", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/vault")>(),
  hasOAuthTokens: vi.fn(() => h.hasTokens),
  refreshOAuthToken: vi.fn(async () => null),
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const child = { kill: vi.fn(), on: vi.fn(), unref: vi.fn() };
    h.children.push(child);
    return child;
  }),
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
    const key = `${_cmd} ${_args.join(" ")}`;
    const code = h.execFileResults.get(key) ?? h.execFileResults.get(_cmd) ?? 1;
    cb(code === 0 ? null : new Error(`exit code ${code}`));
  }),
}));

import { authenticateBag, resetBagAuthState } from "./bag-auth.js";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { BagConnectionPool, type FilterableProxiedTool } from "./bag-proxy.js";
import type { Bag } from "@barry-rocks/sdk/bags";

function makeTool(bag: string, name: string): FilterableProxiedTool {
  return {
    name,
    description: "",
    inputSchema: {},
    bag,
    namespace: bag,
    access: "read",
    proxy: {} as FilterableProxiedTool["proxy"],
  };
}

type FakePool = BagConnectionPool & {
  retryConnect: ReturnType<typeof vi.fn>;
  clearCooldown: ReturnType<typeof vi.fn>;
};

function makePool(): FakePool {
  const notionConfig = { name: "notion", url: "https://mcp.notion.com/mcp" };
  return Object.assign(new BagConnectionPool([]), {
    originalConfigs: {
      notion: notionConfig,
      "local-only": { name: "local-only", command: "node", args: ["server.js"] },
      "datadog-remote": {
        name: "datadog-remote",
        command: "npx",
        args: [
          "-y",
          "mcp-remote",
          "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp",
          "--header",
          "DD-API-KEY: ${DD_API_KEY}",
          "--header",
          "DD-APPLICATION-KEY: ${DD_APP_KEY}",
        ],
        env: ["DD_API_KEY", "DD_APP_KEY"],
      },
    },
    needsAuth: { notion: notionConfig },
    authExpired: {},
    failedSharedConfigs: {},
    deferredConfigs: {},
    shared: [],
    connectedSharedBags: new Set<string>(),
    retryConnect: vi.fn(),
    clearCooldown: vi.fn(),
  });
}

describe("authenticateBag", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetBagAuthState();
    h.hasTokens = false;
    h.children.length = 0;
    h.execFileResults.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails without spawning for unknown bags", async () => {
    const pool = makePool();
    const result = await authenticateBag(pool, "nope");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Unknown bag");
    expect(h.children).toHaveLength(0);
  });

  it("fails without spawning for bags with no MCP server URL", async () => {
    const pool = makePool();
    const result = await authenticateBag(pool, "local-only");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("no MCP server URL");
    expect(h.children).toHaveLength(0);
  });

  it("API-key bag: never spawns, reports missing keys when unset", async () => {
    vi.stubEnv("DD_API_KEY", "");
    vi.stubEnv("DD_APP_KEY", "");
    const pool = makePool();

    const result = await authenticateBag(pool, "datadog-remote");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("API keys");
    expect(result.message).toContain("not OAuth");
    expect(result.message).toContain("DD_API_KEY");
    expect(result.message).toContain("DD_APP_KEY");
    expect(h.children).toHaveLength(0);

    vi.unstubAllEnvs();
  });

  it("API-key bag: never spawns, says keys are set when present", async () => {
    vi.stubEnv("DD_API_KEY", "key");
    vi.stubEnv("DD_APP_KEY", "app-key");
    const pool = makePool();

    const result = await authenticateBag(pool, "datadog-remote");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("not OAuth");
    expect(result.message).toContain("already set");
    expect(h.children).toHaveLength(0);

    vi.unstubAllEnvs();
  });

  it("runs the installed pinned OAuth helper without inherited credentials or Node injection", async () => {
    for (const key of ["BARRY_SECRET", "BARRY_HOME", "VENDOR_API_KEY", "SERVICE_TOKEN", "CLIENT_SECRET", "NODE_OPTIONS", "NODE_PATH"]) vi.stubEnv(key, "must-not-inherit");
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:8888");
    vi.stubEnv("NO_PROXY", "localhost");
    const pending = authenticateBag(makePool(), "notion");
    h.hasTokens = true; await vi.advanceTimersByTimeAsync(2_000); await pending;
    const [command, args, options] = vi.mocked(spawn).mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args).toEqual([createRequire(import.meta.url).resolve("mcp-remote/dist/proxy.js"), "https://mcp.notion.com/mcp", "--enable-proxy"]);
    const environment = (options as { env: NodeJS.ProcessEnv }).env;
    expect(environment).toMatchObject({ HOME: process.env.HOME, HTTPS_PROXY: "http://127.0.0.1:8888", NO_PROXY: "localhost" });
    expect(Object.keys(environment).filter(key => /^BARRY_|(?:KEY|TOKEN|SECRET)$|^NODE_(?:OPTIONS|PATH)$/.test(key))).toEqual([]);
  });

  it("success path: one OAuth flow, reconnect, buckets cleared, shared repopulated", async () => {
    const pool = makePool();
    pool.retryConnect.mockResolvedValue([makeTool("notion", "notion_search")]);

    const pending = authenticateBag(pool, "notion");
    // Tokens land before the first poll tick
    h.hasTokens = true;
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(result.tools).toBe(1);
    expect(h.children).toHaveLength(1);
    expect(h.children[0].kill).toHaveBeenCalled();
    expect(pool.retryConnect).toHaveBeenCalledWith(pool.originalConfigs["notion"]);
    expect(pool.needsAuth).not.toHaveProperty("notion");
    expect(pool.shared.map((t) => t.name)).toContain("notion_search");
  });

  it("single-flight: concurrent calls share one attempt and one spawn", async () => {
    const pool = makePool();
    pool.retryConnect.mockResolvedValue([makeTool("notion", "notion_search")]);

    const p1 = authenticateBag(pool, "notion");
    const p2 = authenticateBag(pool, "notion");

    h.hasTokens = true;
    await vi.advanceTimersByTimeAsync(2_000);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(h.children).toHaveLength(1);
    expect(r1).toBe(r2);
    expect(r1.ok).toBe(true);
  });

  it("times out when authorization never completes and kills the child", async () => {
    const pool = makePool();

    const pending = authenticateBag(pool, "notion");
    await vi.advanceTimersByTimeAsync(120_000);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.message).toContain("did not complete");
    expect(h.children[0].kill).toHaveBeenCalled();
  });

  it("cooldown bags an immediate retry after failure — no second tab", async () => {
    const pool = makePool();

    const pending = authenticateBag(pool, "notion");
    await vi.advanceTimersByTimeAsync(120_000);
    await pending;
    expect(h.children).toHaveLength(1);

    const retry = await authenticateBag(pool, "notion");
    expect(retry.ok).toBe(false);
    expect(retry.message).toContain("failed less than a minute ago");
    expect(h.children).toHaveLength(1);
  });

  it("allows a fresh attempt after the cooldown expires", async () => {
    const pool = makePool();
    pool.retryConnect.mockResolvedValue([makeTool("notion", "notion_search")]);

    const first = authenticateBag(pool, "notion");
    await vi.advanceTimersByTimeAsync(120_000);
    await first;
    expect(h.children).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(61_000);

    const second = authenticateBag(pool, "notion");
    h.hasTokens = true;
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await second;

    expect(result.ok).toBe(true);
    expect(h.children).toHaveLength(2);
  });

  it("fails (and sets cooldown) when tokens land but reconnect fails", async () => {
    const pool = makePool();
    pool.retryConnect.mockResolvedValue(null);

    const pending = authenticateBag(pool, "notion");
    h.hasTokens = true;
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.message).toContain("reconnecting");
    expect(pool.needsAuth).toHaveProperty("notion");

    // Cooldown applies to the failed reconnect too
    const retry = await authenticateBag(pool, "notion");
    expect(retry.ok).toBe(false);
    expect(h.children).toHaveLength(1);
  });

  // ── CLI-delegated auth ──────────────────────────────────────────────────

  function makeCliBag(overrides?: Partial<Bag["manifest"]>): Bag {
    return {
      name: "temporal",
      description: "Temporal bag",
      builtin: false,
      source: { type: "local", path: "/repos/bags/temporal" },
      manifest: {
        version: "v0.1",
        name: "temporal",
        description: "Temporal",
        services: {},
        apps: {},
        schedules: {},
        scripts: {},
        mcpServers: {},
        tools: [],
        dependencies: [],
        auth: {
          command: "temporal",
          args: ["cloud", "login"],
          check: { command: "temporal", args: ["cloud", "whoami"] },
        },
        ...overrides,
      },
      skillsDirs: [],
      actionsDirs: [],
      instructionsDirs: [],
      slashCommands: [],
      hooks: [],
      requires: [],
      services: [],
      apps: [],
      schedules: [],
      mcpServers: {},
      tools: [],
      dependencies: [],
    } satisfies Bag;
  }

  it("CLI-delegated: returns ok immediately when already authenticated", async () => {
    const pool = makePool();
    const bags = [makeCliBag()];
    h.execFileResults.set("temporal cloud whoami", 0);

    const result = await authenticateBag(pool, "temporal", bags);

    expect(result.ok).toBe(true);
    expect(result.message).toContain("already authenticated");
    // No spawn should have happened — the check passed
    expect(h.children).toHaveLength(0);
  });

  it("CLI-delegated: spawns login command and polls check until success", async () => {
    const pool = makePool();
    const bags = [makeCliBag()];
    // Check fails initially, then succeeds after 4s
    const _calls = 0;
    h.execFileResults.set("temporal cloud whoami", 1);

    const pending = authenticateBag(pool, "temporal", bags);

    // First check fails (pre-spawn check), then login spawned
    // After 2s poll: still failing
    await vi.advanceTimersByTimeAsync(2_000);

    // After 4s poll: check succeeds
    h.execFileResults.set("temporal cloud whoami", 0);
    await vi.advanceTimersByTimeAsync(2_000);

    const result = await pending;

    expect(result.ok).toBe(true);
    expect(result.message).toContain("authenticated via temporal");
    // One spawn for the login command (detached)
    expect(h.children).toHaveLength(1);
  });

  it("CLI-delegated: times out when check never passes", async () => {
    const pool = makePool();
    const bags = [makeCliBag()];
    h.execFileResults.set("temporal cloud whoami", 1);

    const pending = authenticateBag(pool, "temporal", bags);
    await vi.advanceTimersByTimeAsync(120_000);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.message).toContain("did not complete");
    expect(result.message).toContain("barry bag auth temporal");
  });

  it("CLI-delegated: cooldown bags immediate retry after timeout", async () => {
    const pool = makePool();
    const bags = [makeCliBag()];
    h.execFileResults.set("temporal cloud whoami", 1);

    const first = authenticateBag(pool, "temporal", bags);
    await vi.advanceTimersByTimeAsync(120_000);
    await first;

    const retry = await authenticateBag(pool, "temporal", bags);
    expect(retry.ok).toBe(false);
    expect(retry.message).toContain("failed less than a minute ago");
  });

  it("CLI-delegated: retries failed bag connection after auth succeeds", async () => {
    const pool = makePool();
    const temporalConfig = { name: "temporal", command: "uvx", args: ["temporal-mcp-server"] };
    pool.failedSharedConfigs = { temporal: temporalConfig };
    pool.retryConnect.mockResolvedValue([makeTool("temporal", "temporal_search")]);
    const bags = [makeCliBag()];
    h.execFileResults.set("temporal cloud whoami", 1);

    const pending = authenticateBag(pool, "temporal", bags);

    // Auth succeeds on first poll
    h.execFileResults.set("temporal cloud whoami", 0);
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(result.tools).toBe(1);
    expect(result.message).toContain("reconnected");
    expect(pool.retryConnect).toHaveBeenCalledWith(temporalConfig);
    expect(pool.failedSharedConfigs).not.toHaveProperty("temporal");
  });

  it("CLI-delegated: works without a check command (fire-and-forget)", async () => {
    const pool = makePool();
    const bags = [makeCliBag({ auth: { command: "vendor", args: ["login"] } })];

    const result = await authenticateBag(pool, "temporal", bags);

    expect(result.ok).toBe(true);
    expect(result.message).toContain("browser window should have opened");
    expect(h.children).toHaveLength(1);
  });

  it("CLI-delegated: takes priority over OAuth path for bags with auth manifest", async () => {
    // Even if the bag also has an MCP server URL in the pool, the manifest
    // auth bag takes precedence.
    const pool = makePool();
    pool.originalConfigs["temporal"] = { name: "temporal", url: "https://temporal.example.com/mcp" };
    const bags = [makeCliBag()];
    h.execFileResults.set("temporal cloud whoami", 0);

    const result = await authenticateBag(pool, "temporal", bags);

    expect(result.ok).toBe(true);
    expect(result.message).toContain("already authenticated");
    // Should NOT have spawned mcp-remote
    expect(h.children).toHaveLength(0);
  });
});
