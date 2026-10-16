import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("an unbuilt checkout gives one actionable line before loading SDK modules", () => {
  const root = mkdtempSync(join(tmpdir(), "barry-unbuilt-"));
  try {
    mkdirSync(join(root, "cli/bin"), { recursive: true });
    mkdirSync(join(root, "cli/src"), { recursive: true });
    writeFileSync(join(root, ".git"), "gitdir: fixture\n");
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: [cli, sdk]\n");
    writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
    copyFileSync(fileURLToPath(new URL("../bin/barry.js", import.meta.url)), join(root, "cli/bin/barry.js"));
    copyFileSync(fileURLToPath(new URL("../bin/entry.js", import.meta.url)), join(root, "cli/bin/entry.js"));
    writeFileSync(join(root, "cli/src/index.ts"), 'import "../../sdk/dist/index.js";\n');
    const result = spawnSync(process.execPath, [join(root, "cli/bin/barry.js"), "--help"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: root, TMPDIR: root } });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("barry: the packages are not built. Run: pnpm build:packages\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
