import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureInstanceSecret, instanceEnvValue, readInstanceEnv, setInstanceEnvValue } from "./instance-env.js";

const file = () => join(mkdtempSync(join(tmpdir(), "instance-env-")), "env");

describe("the instance env file", () => {
  it("uses only the selected file even when a conflicting ambient key exists", () => {
    const path = file();
    const previous = process.env.INSTANCE_KEY;
    process.env.INSTANCE_KEY = "ambient";
    try {
      expect(instanceEnvValue("INSTANCE_KEY", path)).toBeUndefined();
      setInstanceEnvValue("INSTANCE_KEY", "owned", path);
      expect(instanceEnvValue("INSTANCE_KEY", path)).toBe("owned");
    } finally {
      if (previous === undefined) delete process.env.INSTANCE_KEY;
      else process.env.INSTANCE_KEY = previous;
    }
  });
  it("reads back every value exactly as it was set", () => {
    const path = file();
    const values = {
      PLAIN: "abc123",
      SPACED: "two words",
      HASHED: "a#b",
      DOUBLE: 'say "hi"',
      SINGLE: "it's",
    };
    for (const [key, value] of Object.entries(values)) setInstanceEnvValue(key, value, path);
    expect(readInstanceEnv(path)).toEqual(values);
  });

  it("replaces a key in place and keeps comments", () => {
    const path = file();
    setInstanceEnvValue("A", "1", path);
    setInstanceEnvValue("B", "2", path);
    setInstanceEnvValue("A", "3", path);
    expect(readFileSync(path, "utf8")).toBe("A=3\nB=2\n");
  });

  it("is readable by its owner only", () => {
    const path = file();
    setInstanceEnvValue("A", "1", path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("refuses a value it could not read back", () => {
    expect(() => setInstanceEnvValue("A", `both ' and "`, file())).toThrow(/both kinds of quote/);
    expect(() => setInstanceEnvValue("A", "two\nlines", file())).toThrow(/span lines/);
  });

  it("gives a new instance a secret once, and never takes one from the shell", () => {
    const path = file();
    const saved = process.env.BARRY_SECRET;
    process.env.BARRY_SECRET = "from-the-shell";
    try {
      expect(ensureInstanceSecret(path)).toBe(true);
      const secret = readInstanceEnv(path).BARRY_SECRET;
      expect(secret).toMatch(/.{32,}/);
      expect(secret).not.toBe("from-the-shell");
      expect(ensureInstanceSecret(path)).toBe(false);
      expect(readInstanceEnv(path).BARRY_SECRET).toBe(secret);
    } finally {
      if (saved === undefined) delete process.env.BARRY_SECRET;
      else process.env.BARRY_SECRET = saved;
    }
  });
});
