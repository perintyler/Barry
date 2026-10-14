import { symlinkSync, realpathSync } from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { pathToFileURL } from "url";
import {
  resolveBagHooks,
  resolveHookScript,
  hookDispatchCommand,
  hookDispatcherPath,
  CLAUDE_HOOK_EVENTS,
  CURSOR_HOOK_EVENTS,
} from "../hooks.js";
import { parseManifestObject } from "../../bags/manifest.js";
import { barryAppSupportDir, barryCurrentDir } from "../../services/home.mjs";
import { shellWord, nodeTsArgv } from "../../services/node-command.js";
import type { BagHookEvent } from "../../bags/types.js";

const diagnostics = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../logging/emit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/emit.js")>();
  return { ...actual, createLogger: (...args: Parameters<typeof actual.createLogger>) => ({
    ...actual.createLogger(...args), warn: diagnostics.warn,
  }) };
});

const EVENTS: BagHookEvent[] = ["session-start", "session-end", "user-prompt", "stop", "pre-tool", "post-tool"];

describe("hook event maps", () => {
  it("covers every neutral event in both provider maps", () => {
    for (const event of EVENTS) {
      expect(CLAUDE_HOOK_EVENTS[event], event).toBeTruthy();
      expect(CURSOR_HOOK_EVENTS[event]?.length, event).toBeGreaterThan(0);
    }
  });

  it("maps stop to afterAgentResponse with stop as fallback, matching session-tracker registration", () => {
    expect(CURSOR_HOOK_EVENTS.stop).toEqual(["afterAgentResponse", "stop"]);
  });
});

describe("manifest hooks parsing", () => {
  const base = { name: "t", description: "d" };

  it("parses hooks and normalizes kebab keys", () => {
    const manifest = parseManifestObject({
      ...base,
      hooks: [
        {
          event: "session-start",
          run: "hooks/tracker/index.ts",
          args: ["start"],
          "cursor-matcher": "npm ",
          "cursor-events": ["beforeShellExecution"],
          timeout: 10,
        },
      ],
    });
    expect(manifest.hooks).toEqual([
      {
        event: "session-start",
        run: "hooks/tracker/index.ts",
        args: ["start"],
        cursorMatcher: "npm ",
        cursorEvents: ["beforeShellExecution"],
        timeout: 10,
      },
    ]);
  });

  it("rejects unknown hook keys (strict schema)", () => {
    expect(() =>
      parseManifestObject({ ...base, hooks: [{ event: "stop", run: "h.sh", bogus: true }] }),
    ).toThrow();
  });

  it("rejects unknown events", () => {
    expect(() =>
      parseManifestObject({ ...base, hooks: [{ event: "SessionStart", run: "h.sh" }] }),
    ).toThrow();
  });

  it("omits hooks entirely when the manifest declares none", () => {
    expect(parseManifestObject(base).hooks).toBeUndefined();
  });
});

describe("resolveBagHooks", () => {
  let bagDir: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    bagDir = mkdtempSync(join(tmpdir(), "bag-hooks-test-"));
    mkdirSync(join(bagDir, "hooks"), { recursive: true });
    warn = diagnostics.warn.mockReset();
  });

  afterEach(() => {
    rmSync(bagDir, { recursive: true, force: true });
    warn.mockReset();
  });

  it("emits stable dispatcher commands carrying hook identity, never script paths", () => {
    writeFileSync(join(bagDir, "hooks", "t.ts"), "");
    writeFileSync(join(bagDir, "hooks", "h.sh"), "");
    writeFileSync(join(bagDir, "hooks", "j.mjs"), "");
    const resolved = resolveBagHooks(
      bagDir,
      [
        { event: "session-start", run: "hooks/t.ts", args: ["start"] },
        { event: "pre-tool", run: "hooks/h.sh", matcher: "Bash" },
        { event: "stop", run: "hooks/j.mjs" },
        // Second hook on the same event: gets ordinal 1.
        { event: "stop", run: "hooks/t.ts" },
      ],
      "test-bag",
    );
    expect(resolved).toHaveLength(4);
    const dispatch = hookDispatchCommand();
    // Raw script paths must NOT appear in commands — baking them into
    // per-session settings is what stranded running sessions across renames.
    for (const hook of resolved) {
      expect(hook.command).not.toContain(bagDir);
      expect(hook.command.startsWith(`${dispatch} test-bag `)).toBe(true);
    }
    expect(resolved[0].command).toBe(`${dispatch} test-bag session-start 0`);
    expect(resolved[1].command).toBe(`${dispatch} test-bag pre-tool 0`);
    expect(resolved[1].matcher).toBe("Bash");
    expect(resolved[2].command).toBe(`${dispatch} test-bag stop 0`);
    expect(resolved[3].command).toBe(`${dispatch} test-bag stop 1`);
    expect(resolved.every((h) => h.bag === "test-bag")).toBe(true);
  });

  it("resolveHookScript picks runners by extension for the dispatcher", () => {
    writeFileSync(join(bagDir, "hooks", "t.ts"), "");
    writeFileSync(join(bagDir, "hooks", "h.sh"), "");
    writeFileSync(join(bagDir, "hooks", "j.mjs"), "");
    expect(resolveHookScript(bagDir, { run: "hooks/t.ts" })).toEqual({
      scriptPath: join(bagDir, "hooks", "t.ts"),
      runner: "tsx",
    });
    expect(resolveHookScript(bagDir, { run: "hooks/h.sh" })?.runner).toBe("bash");
    expect(resolveHookScript(bagDir, { run: "hooks/j.mjs" })?.runner).toBe("node");
    expect(resolveHookScript(bagDir, { run: "hooks/gone.ts" })).toBeNull();
    expect(resolveHookScript(bagDir, { run: "/abs/path.ts" })).toBeNull();
  });

  it("dispatches with this node and the CLI's barry-hook by absolute path, not whatever PATH finds", () => {
    const command = hookDispatchCommand();
    const node = command.split(" ")[0].replace(/^'|'$/g, "");
    expect(realpathSync(node)).toBe(realpathSync(process.execPath));
    const entry = command.split(" ").at(-1)!.replace(/^'|'$/g, "");
    expect(entry.endsWith(join("cli", "bin", "barry-hook.js"))).toBe(true);
    expect(existsSync(entry)).toBe(true);
  });

  it("drops a hook whose script is missing, with a warning, without failing the bag", () => {
    writeFileSync(join(bagDir, "hooks", "real.sh"), "");
    const resolved = resolveBagHooks(
      bagDir,
      [
        { event: "session-start", run: "hooks/gone.ts" },
        { event: "session-end", run: "hooks/real.sh" },
      ],
      "test-bag",
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0].event).toBe("session-end");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("rejects absolute run paths — a manifest must not point outside its bag", () => {
    const resolved = resolveBagHooks(
      bagDir,
      [{ event: "stop", run: "/etc/passwd" }],
      "test-bag",
    );
    expect(resolved).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("returns [] for undefined or empty hooks", () => {
    expect(resolveBagHooks(bagDir, undefined, "b")).toEqual([]);
    expect(resolveBagHooks(bagDir, [], "b")).toEqual([]);
  });

  it("skips a bag's hooks, loudly, when the dispatcher cannot be found, rather than failing the load", () => {
    writeFileSync(join(bagDir, "hooks", "real.sh"), "");
    const unfindable = () => {
      throw new Error("cannot find Barry's hook dispatcher");
    };
    expect(resolveBagHooks(bagDir, [{ event: "stop", run: "hooks/real.sh" }], "test-bag", unfindable)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("1 hook(s) not resolved"));
  });
});

/**
 * A bag's tools run from a bundle in the cache (~/Library/Caches/Barry/bags/
 * <bag>/tools.js), with no dispatcher beside it and no node_modules above it.
 * Loading bags there threw on every bag with hooks, so every such tool call
 * failed: get_instructions did, for every session, from the cutover on.
 */
describe("the dispatcher, from a bundle outside the checkout", () => {
  const checkout = resolve(import.meta.dirname, "../../../..");
  let cache: string;
  beforeEach(() => {
    cache = mkdtempSync(join(tmpdir(), "bag-cache-"));
  });
  afterEach(() => {
    rmSync(cache, { recursive: true, force: true });
  });

  it("is the one the host names in BARRY_HOOK_DISPATCHER", () => {
    const named = join(cache, "barry-hook.js");
    writeFileSync(named, "");
    expect(hookDispatcherPath(pathToFileURL(join(cache, "tools.js")).href, { BARRY_HOOK_DISPATCHER: named })).toBe(named);
  });

  it("is found in the checkout BARRY_DIR names", () => {
    const bundle = pathToFileURL(join(cache, "tools.js")).href;
    const dispatcher = hookDispatcherPath(bundle, { BARRY_DIR: checkout });
    expect(dispatcher).toBe(join(checkout, "cli", "bin", "barry-hook.js"));
    expect(existsSync(dispatcher!)).toBe(true);
  });

  it("is not found at all without BARRY_DIR, rather than guessed", () => {
    expect(hookDispatcherPath(pathToFileURL(join(cache, "tools.js")).href, {})).toBeNull();
  });

  // Compiled SDK, as a bag's tools load it: no BARRY_DIR, but the checkout's CLI
  // sits three levels above.
  it("is found in the checkout's cli/bin when running from its sdk/dist", () => {
    mkdirSync(join(cache, "sdk", "dist", "hooks"), { recursive: true });
    mkdirSync(join(cache, "cli", "bin"), { recursive: true });
    writeFileSync(join(cache, "cli", "bin", "barry-hook.js"), "");
    const bundled = pathToFileURL(join(cache, "sdk", "dist", "hooks", "hooks.js")).href;
    expect(hookDispatcherPath(bundled, {})).toBe(join(cache, "cli", "bin", "barry-hook.js"));
  });
});

describe("installed hook commands", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "barry-installed-hook-"));
    vi.stubEnv("BARRY_HOME", home);
    vi.stubEnv("BARRY_HOOK_DISPATCHER", undefined);
    mkdirSync(join(home, "target/cli/bin"), { recursive: true });
    mkdirSync(join(home, "target/bin"), { recursive: true });
    mkdirSync(barryAppSupportDir(), { recursive: true });
    symlinkSync(join(home, "target"), barryCurrentDir());
    writeFileSync(join(home, "target/cli/bin/barry-hook.js"), "");
    writeFileSync(join(home, "target/bin/barry-hook"), "");
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
  it("runs the release wrapper directly", () => {
    mkdirSync(join(home, "target/runtime/bin"), { recursive: true });
    symlinkSync(process.execPath, join(home, "target/runtime/bin/node"));
    const path = join(barryCurrentDir(), "bin/barry-hook");
    expect(hookDispatcherPath()).toBe(path);
    expect(hookDispatchCommand()).toBe(shellWord(path));
  });
  it("carries a linked checkout's node in the hook command", () => {
    vi.stubEnv("BARRY_NODE", process.execPath);
    const path = join(barryCurrentDir(), "cli/bin/barry-hook.js");
    expect(hookDispatcherPath()).toBe(path);
    expect(hookDispatchCommand()).toBe([process.execPath, path].map(shellWord).join(" "));
  });
});
