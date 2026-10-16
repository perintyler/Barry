import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { scaffoldActionDir, scaffoldInstruction, scaffoldBound } from "../scaffold-kinds.js";
import { parseActionFile } from "@barry-rocks/sdk/internal/actions";
import { parseManifestObject } from "@barry-rocks/sdk/bags";
import { parse } from "yaml";

let bagDir: string;

const MANIFEST_WITH_COMMENTS = `version: v0.1
name: demo
description: Demo bag

# Host binaries this bag needs at runtime.
# dependencies:
#   - name: some-cli
#     install: brew install some-cli
`;

beforeEach(() => {
  bagDir = mkdtempSync(join(tmpdir(), "scaffold-kinds-"));
  writeFileSync(join(bagDir, "bag.yaml"), MANIFEST_WITH_COMMENTS, "utf-8");
});

afterEach(() => rmSync(bagDir, { recursive: true, force: true }));

describe("scaffoldActionDir", () => {
  it("writes an action that parses", () => {
    const { files } = scaffoldActionDir({ bagDir, name: "do-thing", description: "Does the thing" });
    expect(files).toHaveLength(1);
    const action = parseActionFile(join(bagDir, "actions", "do-thing"));
    expect(action.name).toBe("do-thing");
    expect(action.description).toBe("Does the thing");
  });

  it("refuses to overwrite an existing action", () => {
    scaffoldActionDir({ bagDir, name: "dup" });
    expect(() => scaffoldActionDir({ bagDir, name: "dup" })).toThrow(/already exists/);
  });

  it("rejects a non-kebab-case name", () => {
    expect(() => scaffoldActionDir({ bagDir, name: "Bad_Name" })).toThrow(/kebab-case/);
  });

  it("can write into skills/ for an in-place conversion layout", () => {
    scaffoldActionDir({ bagDir, name: "legacy", intoSkills: true });
    expect(existsSync(join(bagDir, "skills", "legacy", "action.yaml"))).toBe(true);
  });
});

describe("scaffoldInstruction", () => {
  it("defaults to on-demand", () => {
    scaffoldInstruction({ bagDir, name: "guide" });
    const body = readFileSync(join(bagDir, "instructions", "guide.md"), "utf-8");
    expect(body).toContain("mode: on-demand");
  });

  it("honors always and warns about the cost", () => {
    const { hint } = scaffoldInstruction({ bagDir, name: "guide", mode: "always" });
    expect(readFileSync(join(bagDir, "instructions", "guide.md"), "utf-8")).toContain("mode: always");
    expect(hint).toMatch(/every turn/);
  });

  it("refuses to overwrite", () => {
    scaffoldInstruction({ bagDir, name: "guide" });
    expect(() => scaffoldInstruction({ bagDir, name: "guide" })).toThrow(/already exists/);
  });
});

describe("scaffoldBound", () => {
  it("adds a bound the manifest parser accepts", () => {
    scaffoldBound({ bagDir, name: "readonly", description: "Read-only demo bound" });
    const manifest = parseManifestObject(parse(readFileSync(join(bagDir, "bag.yaml"), "utf-8")), "demo");
    expect(manifest.bounds?.["demo:readonly"]).toEqual({
      description: "Read-only demo bound",
      tools: {
        deny: ["demo:write"],
      },
      bound: {
        tools: {
          deny: ["demo:write"],
        },
      },
    });
  });

  it("preserves comments in bag.yaml", () => {
    scaffoldBound({ bagDir, name: "readonly" });
    const after = readFileSync(join(bagDir, "bag.yaml"), "utf-8");
    expect(after).toContain("# Host binaries this bag needs at runtime.");
    expect(after).toContain("#     install: brew install some-cli");
  });

  it("refuses to redefine an existing bound", () => {
    scaffoldBound({ bagDir, name: "readonly" });
    expect(() => scaffoldBound({ bagDir, name: "readonly" })).toThrow(/already exists/);
  });

  it("fails when there is no bag.yaml", () => {
    const empty = mkdtempSync(join(tmpdir(), "no-bag-"));
    try {
      expect(() => scaffoldBound({ bagDir: empty, name: "readonly" })).toThrow(/No bag.yaml/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("names the qualified bound reference in its hint", () => {
    expect(scaffoldBound({ bagDir, name: "readonly" }).hint).toContain("demo:readonly");
  });
});

describe("scaffolded output is loadable end to end", () => {
  it("an action scaffolded into a fresh bag parses with requires defaulted", () => {
    mkdirSync(join(bagDir, "actions"), { recursive: true });
    scaffoldActionDir({ bagDir, name: "loadable" });
    const action = parseActionFile(join(bagDir, "actions", "loadable"));
    expect(action.requires).toEqual({ tools: [], secrets: [], bins: [] });
    expect(action.prompt).toContain("${ACTION_DIR}");
  });
});
