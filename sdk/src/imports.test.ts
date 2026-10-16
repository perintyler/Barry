import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
it("imports and uses concepts without an installation, listener, or child process", () => {
  const home = mkdtempSync(join(tmpdir(), "barry-inert-"));
  try {
    const script = `
      import { syncBuiltinESMExports } from "node:module";
      import child from "node:child_process"; import net from "node:net";
      for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) child[key] = () => { throw new Error("unexpected child process"); };
      net.Server.prototype.listen = () => { throw new Error("unexpected listener"); };
      globalThis.fetch = () => { throw new Error("unexpected network request"); };
      syncBuiltinESMExports();
      await import("@barry-rocks/sdk");
      await import("@barry-rocks/sdk/openapi.json", { with: { type: "json" } });
      for (const name of ["testing", "tools", "bags", "services", "services/http", "stores", "logging", "logging/edge", "auth", "apps", "events", "transcripts", "ids", "http", "acp", "mcp", "bounds", "sessions", "adapters/harnesses", "adapters/models", "internal/identities", "internal/instructions"]) await import("@barry-rocks/sdk/" + name);
      const { parseBounds } = await import("@barry-rocks/sdk/internal/identities");
      if (parseBounds(["readonly"]).map((b) => b.name).join() !== "readonly") throw new Error("unexpected selection");
    `;
    const env = { ...process.env, HOME: home, BARRY_HOME: home, TSX_DISABLE_CACHE: "1" };
    for (const key of Object.keys(env)) if (key.startsWith("BARRY_") && key !== "BARRY_HOME") delete (env as Record<string, string | undefined>)[key];
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: join(import.meta.dirname, ".."), encoding: "utf8", env, timeout: 20000 });
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(home)).toEqual([]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
