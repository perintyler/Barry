import { expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateLog, tailLog } from "./logs.js";
it("retains bounded archives and reads recent lines across a stopped service's rotation", () => {
  const home = mkdtempSync(join(tmpdir(), "barry-log-")),
    path = join(home, "out.log");
  try {
    for (const line of ["old", "previous", "recent", "newest"]) {
      writeFileSync(path, `${line}\n`);
      rotateLog(path, { keep: 3 });
    }
    expect(readFileSync(`${path}.3`, "utf8")).toBe("previous\n");
    writeFileSync(path, "current\n");
    expect(tailLog(path, 3)).toBe("newest\ncurrent");
    expect(() => tailLog(path, -1)).toThrow("between 1 and 10000");
    writeFileSync(path, "x".repeat(2 * 1024 * 1024) + "\nend\n");
    expect(tailLog(path, 1)).toBe("end");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
