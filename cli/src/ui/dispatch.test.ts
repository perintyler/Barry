import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  resolveUiRenderer,
  launchSessionUi,
  normalizeRenderer,
  probeBinary,
  type SessionUiContext,
  type UiSpawnChild,
  type UiSpawnFn,
} from "./dispatch.js";

describe("normalizeRenderer", () => {
  it("normalizes canonical renderer names", () => {
    expect(normalizeRenderer("btui")).toBe("btui");
    expect(normalizeRenderer("web")).toBe("web");
    expect(normalizeRenderer("app")).toBe("app");
    expect(normalizeRenderer("raw")).toBe("raw");
    expect(normalizeRenderer("none")).toBe("none");
  });

  it("handles case insensitivity and whitespace", () => {
    expect(normalizeRenderer("  BTUI  ")).toBe("btui");
    expect(normalizeRenderer("Web")).toBe("web");
    expect(normalizeRenderer("  APP ")).toBe("app");
    expect(normalizeRenderer("RAW")).toBe("raw");
    expect(normalizeRenderer(" NONE ")).toBe("none");
  });

  it("normalizes known aliases", () => {
    expect(normalizeRenderer("readline")).toBe("raw");
    expect(normalizeRenderer("terminal")).toBe("raw");
    expect(normalizeRenderer("cli")).toBe("raw");
    expect(normalizeRenderer("browser")).toBe("web");
    expect(normalizeRenderer("desktop")).toBe("app");
    expect(normalizeRenderer("no-ui")).toBe("none");
    expect(normalizeRenderer("false")).toBe("none");
  });

  it("returns null for unrecognized or invalid input", () => {
    expect(normalizeRenderer("unknown")).toBeNull();
    expect(normalizeRenderer("")).toBeNull();
    expect(normalizeRenderer(null)).toBeNull();
    expect(normalizeRenderer(undefined)).toBeNull();
    expect(normalizeRenderer(123)).toBeNull();
  });
});

describe("probeBinary", () => {
  it("returns false if PATH is not defined or empty", () => {
    expect(probeBinary("btui", { PATH: "" })).toBe(false);
    expect(probeBinary("btui", {})).toBe(false);
  });

  it("finds existing executable binaries in PATH", () => {
    // node and sh exist on mac/unix
    const hasSh = probeBinary("sh", { PATH: "/bin:/usr/bin" });
    expect(hasSh).toBe(true);
  });

  it("returns false for nonexistent binaries", () => {
    const hasNonexistent = probeBinary("nonexistent_binary_xyz_12345", { PATH: "/bin:/usr/bin" });
    expect(hasNonexistent).toBe(false);
  });
});

describe("resolveUiRenderer", () => {
  const originalEnv = process.env.BARRY_UI;
  const originalStdoutTTY = process.stdout.isTTY;
  const originalStdinTTY = process.stdin.isTTY;

  beforeEach(() => {
    delete process.env.BARRY_UI;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.BARRY_UI = originalEnv;
    } else {
      delete process.env.BARRY_UI;
    }
    process.stdout.isTTY = originalStdoutTTY;
    process.stdin.isTTY = originalStdinTTY;
  });

  describe("CLI flags precedence", () => {
    it("prioritizes --no-ui flag over all other sources", () => {
      process.env.BARRY_UI = "web";
      const identity = { configuration: { ui: "btui" } };
      expect(resolveUiRenderer({ noUi: true }, identity)).toBe("none");
    });

    it("prioritizes --ui false or --ui none over all other sources", () => {
      process.env.BARRY_UI = "btui";
      const identity = { configuration: { ui: "web" } };
      expect(resolveUiRenderer({ ui: false }, identity)).toBe("none");
      expect(resolveUiRenderer({ ui: "none" }, identity)).toBe("none");
      expect(resolveUiRenderer({ ui: "no-ui" }, identity)).toBe("none");
    });

    it("prioritizes --ui <renderer> over environment variable and identity config", () => {
      process.env.BARRY_UI = "btui";
      const identity = { configuration: { ui: "btui" } };

      expect(resolveUiRenderer({ ui: "web" }, identity)).toBe("web");
      expect(resolveUiRenderer({ ui: "app" }, identity)).toBe("app");
      expect(resolveUiRenderer({ ui: "raw" }, identity)).toBe("raw");
      expect(resolveUiRenderer({ ui: "readline" }, identity)).toBe("raw");
      expect(resolveUiRenderer({ ui: "btui" }, identity)).toBe("btui");
    });

    it("throws a clear error on invalid --ui flag value", () => {
      expect(() => resolveUiRenderer({ ui: "invalid-ui" })).toThrow(
        /Invalid UI renderer "invalid-ui"/,
      );
    });
  });

  describe("Environment variable BARRY_UI", () => {
    it("uses BARRY_UI when no CLI flag is passed", () => {
      const identity = { configuration: { ui: "btui" } };

      expect(resolveUiRenderer({}, identity, { env: { BARRY_UI: "web" } })).toBe("web");
      expect(resolveUiRenderer({}, identity, { env: { BARRY_UI: "app" } })).toBe("app");
      expect(resolveUiRenderer({}, identity, { env: { BARRY_UI: "raw" } })).toBe("raw");
      expect(resolveUiRenderer({}, identity, { env: { BARRY_UI: "readline" } })).toBe("raw");
      expect(resolveUiRenderer({}, identity, { env: { BARRY_UI: "none" } })).toBe("none");
    });

    it("throws a clear error on invalid BARRY_UI value", () => {
      expect(() => resolveUiRenderer({}, null, { env: { BARRY_UI: "bad_val" } })).toThrow(
        /Invalid UI renderer in BARRY_UI "bad_val"/,
      );
    });
  });

  describe("Identity configuration", () => {
    it("uses identity configuration.ui when no flag or env var is present", () => {
      const identity = { configuration: { ui: "btui" } };
      expect(resolveUiRenderer({}, identity)).toBe("btui");

      const webIdentity = { configuration: { ui: "web" } };
      expect(resolveUiRenderer({}, webIdentity)).toBe("web");
    });

    it("uses identity.ui when no flag or env var is present", () => {
      const identity = { ui: "raw" };
      expect(resolveUiRenderer({}, identity)).toBe("raw");
    });

    it("throws a clear error on invalid identity ui value", () => {
      const badIdentity = { configuration: { ui: "unsupported" } };
      expect(() => resolveUiRenderer({}, badIdentity)).toThrow(
        /Invalid UI renderer in identity config "unsupported"/,
      );
    });
  });

  describe("TTY / PATH probe fallback", () => {
    it("falls back to btui when in TTY and btui binary exists in PATH", () => {
      const result = resolveUiRenderer({}, null, {
        isTty: true,
        hasBinary: (bin) => bin === "btui",
      });
      expect(result).toBe("btui");
    });

    it("falls back to raw when in TTY but btui binary does not exist in PATH", () => {
      const result = resolveUiRenderer({}, null, {
        isTty: true,
        hasBinary: () => false,
      });
      expect(result).toBe("raw");
    });

    it("falls back to raw when non-interactive (non-TTY) and identity has no ui set", () => {
      const result = resolveUiRenderer({}, null, {
        isTty: false,
        hasBinary: () => true,
      });
      expect(result).toBe("raw");
    });

    it("falls back to raw when both TTY is false and btui is missing", () => {
      const result = resolveUiRenderer({}, null, {
        isTty: false,
        hasBinary: () => false,
      });
      expect(result).toBe("raw");
    });
  });
});

describe("launchSessionUi", () => {
  interface MockChildProcess extends EventEmitter {
    kill: (signal?: NodeJS.Signals | number) => boolean;
    pid: number;
  }

  function makeMockChildProcess(): MockChildProcess {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      kill: vi.fn().mockReturnValue(true),
      pid: 99999,
    });
  }

  const baseContext: SessionUiContext = {
    sessionId: "sess-test-456",
    tmpDirs: ["/tmp/barry-test-dir"],
    harness: "claude",
  };

  describe("renderer: none", () => {
    it("prints only sessionId to stdout and exits with 0", async () => {
      let stdoutOutput = "";
      const stdout = { write: (str: string) => { stdoutOutput += str; } };
      const cleanupMock = vi.fn();
      const exitMock = vi.fn();
      const printHintMock = vi.fn();

      const result = await launchSessionUi(baseContext, {
        renderer: "none",
        stdout,
        cleanupTmpDirs: cleanupMock,
        exit: exitMock,
        printResumeHint: printHintMock,
      });

      expect(result).toEqual({ renderer: "none", exitCode: 0 });
      expect(stdoutOutput.trim()).toBe("sess-test-456");
      expect(cleanupMock).toHaveBeenCalledWith(["/tmp/barry-test-dir"]);
      expect(printHintMock).not.toHaveBeenCalled();
      expect(exitMock).toHaveBeenCalledWith(0);
    });

    it("starts server turn when prompt is provided", async () => {
      const stdout = { write: vi.fn() };
      const startTurnMock = vi.fn().mockResolvedValue(null);
      const exitMock = vi.fn();

      await launchSessionUi({ ...baseContext, prompt: "test prompt" }, {
        renderer: "none",
        stdout,
        startTurn: startTurnMock,
        exit: exitMock,
      });

      expect(startTurnMock).toHaveBeenCalledWith(
        "sess-test-456",
        expect.objectContaining({ prompt: "test prompt", harness: "claude" }),
        expect.anything(),
      );
      expect(exitMock).toHaveBeenCalledWith(0);
    });

    it("handles refused server turn with exit 1 and cleanup", async () => {
      let stderrOutput = "";
      const stderr = { write: (str: string) => { stderrOutput += str; } };
      const cleanupMock = vi.fn();
      const exitMock = vi.fn();
      const startTurnMock = vi.fn().mockResolvedValue("Harness busy");

      const result = await launchSessionUi({ ...baseContext, prompt: "test prompt" }, {
        renderer: "none",
        stderr,
        cleanupTmpDirs: cleanupMock,
        startTurn: startTurnMock,
        exit: exitMock,
      });

      expect(result).toEqual({ renderer: "none", exitCode: 1 });
      expect(stderrOutput).toContain("Could not start turn: Harness busy");
      expect(cleanupMock).toHaveBeenCalledWith(["/tmp/barry-test-dir"]);
      expect(exitMock).toHaveBeenCalledWith(1);
    });
  });

  describe("renderer: web", () => {
    it("launches browser with session URL, logs message, prints hint, and exits 0", async () => {
      let stdoutOutput = "";
      const stdout = { write: (str: string) => { stdoutOutput += str; } };
      const cleanupMock = vi.fn();
      const exitMock = vi.fn();
      const printHintMock = vi.fn();
      const openBrowserMock = vi.fn().mockResolvedValue(undefined);

      const result = await launchSessionUi(baseContext, {
        renderer: "web",
        apiPort: 8420,
        stdout,
        openBrowser: openBrowserMock,
        cleanupTmpDirs: cleanupMock,
        printResumeHint: printHintMock,
        exit: exitMock,
      });

      expect(result).toEqual({ renderer: "web", exitCode: 0 });
      expect(openBrowserMock).toHaveBeenCalledWith("http://localhost:8420/sessions/sess-test-456");
      expect(stdoutOutput).toContain("Session sess-test-456 opened in browser: http://localhost:8420/sessions/sess-test-456");
      expect(cleanupMock).toHaveBeenCalledWith(["/tmp/barry-test-dir"]);
      expect(printHintMock).toHaveBeenCalledWith("sess-test-456");
      expect(exitMock).toHaveBeenCalledWith(0);
    });

    it("starts server turn when prompt is provided before launching browser", async () => {
      const openBrowserMock = vi.fn().mockResolvedValue(undefined);
      const startTurnMock = vi.fn().mockResolvedValue(null);
      const exitMock = vi.fn();

      await launchSessionUi({ ...baseContext, prompt: "do web work" }, {
        renderer: "web",
        apiPort: 8420,
        openBrowser: openBrowserMock,
        startTurn: startTurnMock,
        exit: exitMock,
      });

      expect(startTurnMock).toHaveBeenCalledWith(
        "sess-test-456",
        expect.objectContaining({ prompt: "do web work" }),
        expect.anything(),
      );
      expect(openBrowserMock).toHaveBeenCalled();
      expect(exitMock).toHaveBeenCalledWith(0);
    });

    it("exits with 1 when turn is refused before browser launch", async () => {
      const openBrowserMock = vi.fn();
      const startTurnMock = vi.fn().mockResolvedValue("Denied");
      const exitMock = vi.fn();
      const cleanupMock = vi.fn();

      const result = await launchSessionUi({ ...baseContext, prompt: "do web work" }, {
        renderer: "web",
        apiPort: 8420,
        openBrowser: openBrowserMock,
        startTurn: startTurnMock,
        cleanupTmpDirs: cleanupMock,
        exit: exitMock,
      });

      expect(result.exitCode).toBe(1);
      expect(openBrowserMock).not.toHaveBeenCalled();
      expect(cleanupMock).toHaveBeenCalled();
      expect(exitMock).toHaveBeenCalledWith(1);
    });
  });

  describe("renderer: app", () => {
    it("launches desktop app with barry:// URL, cleans up, prints hint, and exits 0", async () => {
      let stdoutOutput = "";
      const stdout = { write: (str: string) => { stdoutOutput += str; } };
      const cleanupMock = vi.fn();
      const exitMock = vi.fn();
      const printHintMock = vi.fn();
      const openAppMock = vi.fn().mockResolvedValue(undefined);

      const result = await launchSessionUi(baseContext, {
        renderer: "app",
        stdout,
        openApp: openAppMock,
        cleanupTmpDirs: cleanupMock,
        printResumeHint: printHintMock,
        exit: exitMock,
      });

      expect(result).toEqual({ renderer: "app", exitCode: 0 });
      expect(openAppMock).toHaveBeenCalledWith("barry://sess-test-456");
      expect(stdoutOutput).toContain("Session sess-test-456 opened in app: barry://sess-test-456");
      expect(cleanupMock).toHaveBeenCalledWith(["/tmp/barry-test-dir"]);
      expect(printHintMock).toHaveBeenCalledWith("sess-test-456");
      expect(exitMock).toHaveBeenCalledWith(0);
    });

    it("starts server turn when prompt is provided before opening app", async () => {
      const openAppMock = vi.fn().mockResolvedValue(undefined);
      const startTurnMock = vi.fn().mockResolvedValue(null);
      const exitMock = vi.fn();

      await launchSessionUi({ ...baseContext, prompt: "open app session" }, {
        renderer: "app",
        openApp: openAppMock,
        startTurn: startTurnMock,
        exit: exitMock,
      });

      expect(startTurnMock).toHaveBeenCalledWith(
        "sess-test-456",
        expect.objectContaining({ prompt: "open app session" }),
        expect.anything(),
      );
      expect(openAppMock).toHaveBeenCalledWith("barry://sess-test-456");
      expect(exitMock).toHaveBeenCalledWith(0);
    });
  });

  describe("renderer: btui", () => {
    it("spawns btui with stdio: inherit and detaches gracefully (exit 0) on close", async () => {
      const mockChild = makeMockChildProcess();
      const spawnMock: UiSpawnFn = vi.fn((_cmd, _args, _opts): UiSpawnChild => {
        setTimeout(() => {
          mockChild.emit("spawn");
          setTimeout(() => {
            mockChild.emit("close", 0);
          }, 10);
        }, 10);
        return mockChild;
      });

      const cleanupMock = vi.fn();
      const printHintMock = vi.fn();
      const exitMock = vi.fn();

      const result = await launchSessionUi(baseContext, {
        renderer: "btui",
        spawn: spawnMock,
        cleanupTmpDirs: cleanupMock,
        printResumeHint: printHintMock,
        exit: exitMock,
      });

      expect(spawnMock).toHaveBeenCalledWith("btui", ["sess-test-456"], {
        stdio: "inherit",
        env: process.env,
      });
      expect(result).toEqual({ renderer: "btui", exitCode: 0 });
      expect(cleanupMock).toHaveBeenCalledWith(["/tmp/barry-test-dir"]);
      expect(printHintMock).toHaveBeenCalledWith("sess-test-456");
      expect(exitMock).toHaveBeenCalledWith(0);
    });

    it("detaches gracefully (exit 0) even if btui exits with non-zero or null signal", async () => {
      const mockChild = makeMockChildProcess();
      const spawnMock: UiSpawnFn = vi.fn((_cmd, _args, _opts): UiSpawnChild => {
        setTimeout(() => {
          mockChild.emit("spawn");
          setTimeout(() => {
            // e.g. closed by user pressing Ctrl-C or terminal detachment
            mockChild.emit("close", null);
          }, 10);
        }, 10);
        return mockChild;
      });

      const exitMock = vi.fn();
      const cleanupMock = vi.fn();

      const result = await launchSessionUi(baseContext, {
        renderer: "btui",
        spawn: spawnMock,
        cleanupTmpDirs: cleanupMock,
        exit: exitMock,
      });

      expect(result.exitCode).toBe(0);
      expect(cleanupMock).toHaveBeenCalled();
      expect(exitMock).toHaveBeenCalledWith(0);
    });

    it("falls back to raw terminal when btui binary throws synchronously on spawn", async () => {
      let stderrOutput = "";
      const stderr = { write: (str: string) => { stderrOutput += str; } };
      const spawnMock: UiSpawnFn = vi.fn((): UiSpawnChild => {
        throw new Error("spawn btui ENOENT");
      });

      const runRawTerminalMock = vi.fn().mockResolvedValue(0);
      const cleanupMock = vi.fn();
      const printHintMock = vi.fn();
      const exitMock = vi.fn();

      const result = await launchSessionUi(baseContext, {
        renderer: "btui",
        stderr,
        spawn: spawnMock,
        runRawTerminal: runRawTerminalMock,
        cleanupTmpDirs: cleanupMock,
        printResumeHint: printHintMock,
        exit: exitMock,
      });

      expect(stderrOutput).toContain("Could not launch btui (spawn btui ENOENT); falling back to basic terminal.");
      expect(runRawTerminalMock).toHaveBeenCalledWith(baseContext, expect.anything());
      expect(result).toEqual({ renderer: "raw", exitCode: 0 });
      expect(cleanupMock).toHaveBeenCalled();
      expect(printHintMock).toHaveBeenCalledWith("sess-test-456");
      expect(exitMock).toHaveBeenCalledWith(0);
    });

    it("falls back to raw terminal when btui child process emits error event (missing binary)", async () => {
      let stderrOutput = "";
      const stderr = { write: (str: string) => { stderrOutput += str; } };
      const mockChild = makeMockChildProcess();
      const spawnMock: UiSpawnFn = vi.fn((_cmd, _args, _opts): UiSpawnChild => {
        setTimeout(() => {
          const err = Object.assign(new Error("spawn btui ENOENT"), { code: "ENOENT" });
          mockChild.emit("error", err);
        }, 10);
        return mockChild;
      });

      const runRawTerminalMock = vi.fn().mockResolvedValue(0);
      const cleanupMock = vi.fn();
      const printHintMock = vi.fn();
      const exitMock = vi.fn();

      const result = await launchSessionUi(baseContext, {
        renderer: "btui",
        stderr,
        spawn: spawnMock,
        runRawTerminal: runRawTerminalMock,
        cleanupTmpDirs: cleanupMock,
        printResumeHint: printHintMock,
        exit: exitMock,
      });

      expect(stderrOutput).toContain("btui launch failed (spawn btui ENOENT); falling back to basic terminal.");
      expect(runRawTerminalMock).toHaveBeenCalledWith(baseContext, expect.anything());
      expect(result).toEqual({ renderer: "raw", exitCode: 0 });
      expect(cleanupMock).toHaveBeenCalled();
      expect(printHintMock).toHaveBeenCalledWith("sess-test-456");
      expect(exitMock).toHaveBeenCalledWith(0);
    });

    it("hands the prompt to btui before the POST", async () => {
      const mockChild = makeMockChildProcess();
      const spawnMock: UiSpawnFn = vi.fn((_cmd, _args, _opts): UiSpawnChild => {
        setTimeout(() => {
          mockChild.emit("spawn");
          setTimeout(() => mockChild.emit("close", 0), 10);
        }, 10);
        return mockChild;
      });

      const startTurnMock = vi.fn().mockResolvedValue(null);
      const exitMock = vi.fn();

      await launchSessionUi({ ...baseContext, prompt: "btui task" }, {
        renderer: "btui",
        spawn: spawnMock,
        startTurn: startTurnMock,
        recordHarness:vi.fn(async()=>new Response()),
        exit: exitMock,
      });

      expect(startTurnMock).not.toHaveBeenCalled();
      expect(spawnMock).toHaveBeenCalledWith("btui",["sess-test-456"],expect.objectContaining({env:expect.objectContaining({BTUI_SEND:"btui task",BTUI_REPO_PATH:expect.any(String)})}));
      expect(spawnMock).toHaveBeenCalled();
      expect(exitMock).toHaveBeenCalledWith(0);
    });

    it("leaves turn rejection to btui after displaying the prompt", async () => {
      const child=makeMockChildProcess();
      const spawnMock:UiSpawnFn=vi.fn(()=>{setTimeout(()=>{child.emit("spawn");setTimeout(()=>child.emit("close",0),10);},10);return child;});
      const startTurnMock=vi.fn().mockResolvedValue("Capacity reached");
      const result=await launchSessionUi({...baseContext,prompt:"btui task"},{renderer:"btui",spawn:spawnMock,startTurn:startTurnMock,recordHarness:vi.fn(async()=>new Response()),exit:vi.fn()});
      expect(startTurnMock).not.toHaveBeenCalled();expect(spawnMock).toHaveBeenCalled();expect(result.exitCode).toBe(0);
    });
  });

  describe("renderer: raw", () => {
    it("runs raw terminal handler, cleans up, prints hint, and exits with handler code", async () => {
      const runRawTerminalMock = vi.fn().mockResolvedValue(0);
      const cleanupMock = vi.fn();
      const printHintMock = vi.fn();
      const exitMock = vi.fn();

      const result = await launchSessionUi(baseContext, {
        renderer: "raw",
        runRawTerminal: runRawTerminalMock,
        cleanupTmpDirs: cleanupMock,
        printResumeHint: printHintMock,
        exit: exitMock,
      });

      expect(result).toEqual({ renderer: "raw", exitCode: 0 });
      expect(runRawTerminalMock).toHaveBeenCalledWith(baseContext, expect.anything());
      expect(cleanupMock).toHaveBeenCalledWith(["/tmp/barry-test-dir"]);
      expect(printHintMock).toHaveBeenCalledWith("sess-test-456");
      expect(exitMock).toHaveBeenCalledWith(0);
    });

    it("propagates non-zero exit code from raw terminal handler", async () => {
      const runRawTerminalMock = vi.fn().mockResolvedValue(130);
      const cleanupMock = vi.fn();
      const exitMock = vi.fn();

      const result = await launchSessionUi(baseContext, {
        renderer: "raw",
        runRawTerminal: runRawTerminalMock,
        cleanupTmpDirs: cleanupMock,
        exit: exitMock,
      });

      expect(result).toEqual({ renderer: "raw", exitCode: 130 });
      expect(cleanupMock).toHaveBeenCalled();
      expect(exitMock).toHaveBeenCalledWith(130);
    });
  });

  describe("automatic renderer resolution during launch", () => {
    it("automatically resolves renderer from options and probe when renderer is omitted", async () => {
      let stdoutOutput = "";
      const stdout = { write: (str: string) => { stdoutOutput += str; } };
      const exitMock = vi.fn();

      // --no-ui should automatically resolve to "none"
      const result = await launchSessionUi(baseContext, {
        noUi: true,
        stdout,
        exit: exitMock,
      });

      expect(result.renderer).toBe("none");
      expect(stdoutOutput.trim()).toBe("sess-test-456");
      expect(exitMock).toHaveBeenCalledWith(0);
    });

    it("resolves btui via probe fallback when in TTY with btui available", async () => {
      const mockChild = makeMockChildProcess();
      const spawnMock: UiSpawnFn = vi.fn((_cmd, _args, _opts): UiSpawnChild => {
        setTimeout(() => {
          mockChild.emit("spawn");
          setTimeout(() => mockChild.emit("close", 0), 10);
        }, 10);
        return mockChild;
      });
      const exitMock = vi.fn();

      const result = await launchSessionUi(baseContext, {
        probe: { isTty: true, hasBinary: (b) => b === "btui" },
        spawn: spawnMock,
        exit: exitMock,
      });

      expect(result.renderer).toBe("btui");
      expect(spawnMock).toHaveBeenCalledWith("btui", ["sess-test-456"], expect.anything());
    });

    it("resolves raw via probe fallback when in TTY without btui", async () => {
      const runRawMock = vi.fn().mockResolvedValue(0);
      const exitMock = vi.fn();

      const result = await launchSessionUi(baseContext, {
        probe: { isTty: true, hasBinary: () => false },
        runRawTerminal: runRawMock,
        exit: exitMock,
      });

      expect(result.renderer).toBe("raw");
      expect(runRawMock).toHaveBeenCalled();
    });
  });
});

it("refuses a turn before spawning an older btui that cannot consume BTUI_SEND",async()=>{
 const spawn=vi.fn();const startTurn=vi.fn(async()=>"not admitted");const exit=vi.fn();
 const result=await launchSessionUi({sessionId:"old-client",prompt:"hello"},{renderer:"btui",supportsPendingSend:async()=>false,spawn,startTurn,exit,cleanupTmpDirs:()=>{},stderr:{write:()=>{}}});
 expect(spawn).not.toHaveBeenCalled();expect(startTurn).toHaveBeenCalledOnce();expect(result.exitCode).toBe(1);
});
