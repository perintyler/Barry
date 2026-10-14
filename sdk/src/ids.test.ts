import { describe, expect, it } from "vitest";
import { generateId } from "./ids.js";

describe("generateId", () => {
  it("makes 21 URL-safe characters that never start with a dash, so a command line never reads one as an option", () => {
    const ids = Array.from({ length: 5000 }, generateId);
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_-]{20}$/);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});
