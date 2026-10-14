import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fixture = fileURLToPath(new URL("./fixtures/continuation-process.ts", import.meta.url));
describe("Pi process restart at approval", () => {
  it("exits with no effect, then resumes the original approved effect in a different process", () => {
    const directory = mkdtempSync(join(tmpdir(), "barry-pi-restart-"));
    try {
      const run = (phase: string) => execFileSync(process.execPath, ["--import", "tsx", fixture, directory, phase], { env: { ...process.env, BARRY_HOME: directory, PI_CODING_AGENT_DIR: join(directory, "pi") }, timeout: 15_000, stdio: "pipe" });
      run("pause");
      expect(existsSync(join(directory, "effect.txt"))).toBe(false);
      const paused = JSON.parse(readFileSync(join(directory, "paused.json"), "utf8"));
      expect(paused.calls).toEqual([{ id: "original-effect-write", tool: "fixture_write", input: { path: "effect.txt", content: "Original approved bytes" } }]);
      run("resume");
      const completed = JSON.parse(readFileSync(join(directory, "completed.json"), "utf8"));
      expect(completed.pid).not.toBe(paused.pid);
      expect(completed.providerRequests).toBe(1);
      expect(readFileSync(join(directory, "effect.txt"), "utf8")).toBe("Original approved bytes");
      expect(completed.events.filter((event: { type: string }) => event.type === "tool_use")).toEqual([]);
      const checkpointPath = join(directory, "checkpoint.json");
      const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
      checkpoint.harnessVersion = "incompatible";
      writeFileSync(checkpointPath, JSON.stringify(checkpoint));
      rmSync(join(directory, "effect.txt"));
      expect(() => run("resume")).toThrow();
      expect(existsSync(join(directory, "effect.txt"))).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);
});
