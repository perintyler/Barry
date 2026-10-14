import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb } from "./db.js";
import { record, getFileOwnership, getLastChanges } from "./index.js";

describe("getFileOwnership", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "barry-file-tracker-ownership-"));
    process.env.BARRY_FILE_TRACKER_DB = join(directory, "tracker.db");
  });

  afterEach(() => {
    closeDb();
    delete process.env.BARRY_FILE_TRACKER_DB;
    rmSync(directory, { recursive: true, force: true });
  });

  it("returns empty map for empty input", () => {
    expect(getFileOwnership([])).toEqual(new Map());
  });

  it("returns the most recent session for each file", () => {
    record({ sessionId: "s1", filePath: "/repo/a.ts", tool: "Edit" });
    record({ sessionId: "s2", filePath: "/repo/a.ts", tool: "Write" }); // s2 is newer
    record({ sessionId: "s1", filePath: "/repo/b.ts", tool: "Edit" });

    const result = getFileOwnership(["/repo/a.ts", "/repo/b.ts"]);

    expect(result.get("/repo/a.ts")).toBe("s2");
    expect(result.get("/repo/b.ts")).toBe("s1");
  });

  it("omits files with no recorded change", () => {
    record({ sessionId: "s1", filePath: "/repo/a.ts", tool: "Edit" });

    const result = getFileOwnership(["/repo/a.ts", "/repo/unknown.ts"]);

    expect(result.has("/repo/a.ts")).toBe(true);
    expect(result.has("/repo/unknown.ts")).toBe(false);
  });

  it("handles many files in chunks", () => {
    // Record a change for 600 files (exceeds the 500-chunk size).
    for (let i = 0; i < 600; i++) {
      record({ sessionId: "s1", filePath: `/repo/file-${i}.ts`, tool: "Edit" });
    }

    const paths = Array.from({ length: 600 }, (_, i) => `/repo/file-${i}.ts`);
    const result = getFileOwnership(paths);

    expect(result.size).toBe(600);
    expect(result.get("/repo/file-0.ts")).toBe("s1");
    expect(result.get("/repo/file-599.ts")).toBe("s1");
  });

  it("correctly picks last writer when same session re-edits", () => {
    record({ sessionId: "s1", filePath: "/repo/x.ts", tool: "Edit" });
    record({ sessionId: "s2", filePath: "/repo/x.ts", tool: "Edit" });
    record({ sessionId: "s1", filePath: "/repo/x.ts", tool: "Write" }); // s1 takes it back

    const result = getFileOwnership(["/repo/x.ts"]);
    expect(result.get("/repo/x.ts")).toBe("s1");
  });
  it("returns the full latest change and omits paths without a change", () => {
    record({ sessionId: "s1", filePath: "/repo/a", tool: "Edit" });
    record({ sessionId: "s2", filePath: "/repo/a", tool: "Write", diff: { added: 1 }, sizeBytes: 8 });
    record({ sessionId: "s1", filePath: "/repo/b", tool: "Edit" });
    const result = getLastChanges(["/repo/a", "/repo/b", "/missing"]);
    expect(result).toHaveLength(2);
    expect(result.find(row => row.file_path === "/repo/a")).toMatchObject({
      id: 2, session_id: "s2", tool: "Write", diff: JSON.stringify({ added: 1 }), size_bytes: 8,
      created_at: expect.any(String),
    });
    expect(getLastChanges([])).toEqual([]);
  });

  it("chunks and deduplicates repeated paths", () => {
    const paths = Array.from({ length: 600 }, (_, i) => `/repo/file-${i}`);
    for (const filePath of paths) record({ sessionId: "s1", filePath });
    const result = getLastChanges([...paths, paths[0]]);
    expect(result).toHaveLength(600);
    expect(result.every(row => row.session_id === "s1")).toBe(true);
  });

});
