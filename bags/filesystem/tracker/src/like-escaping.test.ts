import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb } from "./db.js";
import { escapeLike, listChanges, record, searchChanges } from "./index.js";

/**
 * BAG-21: a user-supplied `%` or `_` in a search term must match literally,
 * not act as a LIKE wildcard. Without `ESCAPE '\'` and escaping, `searchChanges("%")`
 * would return every row and `file_path: "a_c"` would also match `abc`.
 */
describe("LIKE metacharacter escaping (BAG-21)", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "barry-file-tracker-like-"));
    process.env.BARRY_FILE_TRACKER_DB = join(directory, "tracker.db");
  });

  afterEach(() => {
    closeDb();
    delete process.env.BARRY_FILE_TRACKER_DB;
    rmSync(directory, { recursive: true, force: true });
  });

  it("escapes the metacharacters themselves", () => {
    expect(escapeLike("50%_off")).toBe("50\\%\\_off");
    expect(escapeLike("a\\b")).toBe("a\\\\b");
    expect(escapeLike("plain")).toBe("plain");
  });

  it("searchChanges treats '%' as a literal, not 'match everything'", () => {
    record({ sessionId: "s1", filePath: "a.ts", diff: { type: "full", content: "no percent here" } });
    record({ sessionId: "s2", filePath: "b.ts", diff: { type: "full", content: "50% complete" } });

    const hits = searchChanges("%");
    // Only the row that literally contains '%' matches; an unescaped '%'
    // pattern would have returned both rows.
    expect(hits).toHaveLength(1);
    expect(hits[0].file_path).toBe("b.ts");
  });

  it("searchChanges treats '_' as a literal, not a single-char wildcard", () => {
    record({ sessionId: "s1", filePath: "snake_case.ts", diff: null });
    record({ sessionId: "s2", filePath: "snakeXcase.ts", diff: null });

    const hits = searchChanges("snake_case");
    expect(hits).toHaveLength(1);
    expect(hits[0].file_path).toBe("snake_case.ts");
  });

  it("the file_path filter treats '_' literally too", () => {
    record({ sessionId: "s1", filePath: "a_c.ts", diff: null });
    record({ sessionId: "s2", filePath: "abc.ts", diff: null });

    const filtered = listChanges({ file_path: "a_c" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].file_path).toBe("a_c.ts");
  });
});
