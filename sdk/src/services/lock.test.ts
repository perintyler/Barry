import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, statSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, matchDirectoryOwner } from "./lock.js";
vi.mock("node:fs", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs")>(), chownSync: vi.fn() }));
afterEach(() => vi.restoreAllMocks());
it("hands new root-written files and locks to their directory owner", () => {
  const root = mkdtempSync(join(tmpdir(), "barry-lock-owner-"));
  try {
    vi.spyOn(process, "getuid").mockReturnValue(0);
    const path = join(root, "record.tmp"); writeFileSync(path, ""); const owner = statSync(root);
    matchDirectoryOwner(path); expect(fs.chownSync).toHaveBeenCalledWith(path, owner.uid, owner.gid);
    const release = acquireLock(root, "system"); expect(fs.chownSync).toHaveBeenCalledWith(join(root, "system.lock"), owner.uid, owner.gid); release();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
