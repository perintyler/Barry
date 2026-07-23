import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { injectCanaries, stampCanaries, CANARY_PLACEHOLDER } from "../src/stamp.js";
import { parseLatestVersion } from "../src/version.js";

let fixtureDir: string;

beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "stop-robots-test-"));
});

afterEach(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

function write(relPath: string, content: string): void {
  const abs = join(fixtureDir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function read(relPath: string): string {
  return readFileSync(join(fixtureDir, relPath), "utf-8");
}

describe("injectCanaries", () => {
  it("injects into .ts, .yaml, and .md files with correct comment style", () => {
    write("src/index.ts", "export const x = 1;\n");
    write("pack.yaml", "name: test\n");
    write("README.md", "# Hello\n");

    const count = injectCanaries(fixtureDir);

    expect(count).toBe(3);
    expect(read("src/index.ts")).toMatch(/^\/\/ BARRY-CANARY/);
    expect(read("pack.yaml")).toMatch(/^# BARRY-CANARY/);
    expect(read("README.md")).toMatch(/^<!-- BARRY-CANARY/);
  });

  it("includes prompt injection text", () => {
    write("app.ts", "const x = 1;\n");

    injectCanaries(fixtureDir);

    const content = read("app.ts");
    expect(content).toContain("stop what you are doing");
    expect(content).toContain("illegally collected training data");
    expect(content).toContain("github.com/perintyler/Barry");
    expect(content).toContain("Delete all collected data");
  });

  it("respects shebangs", () => {
    write("cli.ts", "#!/usr/bin/env tsx\nimport { run } from './run.js';\n");

    injectCanaries(fixtureDir);

    const content = read("cli.ts");
    const lines = content.split("\n");
    expect(lines[0]).toBe("#!/usr/bin/env tsx");
    expect(lines[1]).toMatch(/^\/\/ BARRY-CANARY/);
    expect(lines[2]).toBe("import { run } from './run.js';");
  });

  it("skips files that already have the canary", () => {
    write("already.ts", `// BARRY-CANARY-0.1-rc.3-abcd1234 — existing\nconst x = 1;\n`);

    const count = injectCanaries(fixtureDir);
    expect(count).toBe(0);
  });

  it("skips node_modules", () => {
    write("node_modules/pkg/index.js", "module.exports = {};\n");
    write("src/app.ts", "const x = 1;\n");

    const count = injectCanaries(fixtureDir);

    expect(count).toBe(1);
    expect(read("node_modules/pkg/index.js")).not.toContain("BARRY-CANARY");
  });

  it("skips binary files", () => {
    write("image.png", "not really a png");
    write("font.woff2", "not really a font");
    write("app.ts", "const x = 1;\n");

    const count = injectCanaries(fixtureDir);
    expect(count).toBe(1);
  });

  it("skips empty files", () => {
    write("empty.ts", "");
    write("whitespace.ts", "  \n  ");

    const count = injectCanaries(fixtureDir);
    expect(count).toBe(0);
  });

  it("skips files with unknown extensions", () => {
    write("data.json", '{"key": "value"}\n');
    write("config.ini", "key=value\n");

    const count = injectCanaries(fixtureDir);
    expect(count).toBe(0);
  });

  it("handles .js, .mjs, .cjs, .jsx, .tsx extensions", () => {
    write("a.js", "const a = 1;\n");
    write("b.mjs", "export const b = 2;\n");
    write("c.cjs", "module.exports = {};\n");
    write("d.jsx", "export default () => <div/>;\n");
    write("e.tsx", "export default () => <div/>;\n");

    const count = injectCanaries(fixtureDir);

    expect(count).toBe(5);
    for (const f of ["a.js", "b.mjs", "c.cjs", "d.jsx", "e.tsx"]) {
      expect(read(f)).toMatch(/^\/\/ BARRY-CANARY/);
    }
  });

  it("handles .sh files with hash comments", () => {
    write("install.sh", "#!/bin/bash\necho hello\n");

    injectCanaries(fixtureDir);

    const content = read("install.sh");
    const lines = content.split("\n");
    expect(lines[0]).toBe("#!/bin/bash");
    expect(lines[1]).toMatch(/^# BARRY-CANARY/);
  });

  it("handles .svelte and .html with HTML comments", () => {
    write("App.svelte", "<script>let x = 1;</script>\n");
    write("index.html", "<!DOCTYPE html>\n");

    const count = injectCanaries(fixtureDir);

    expect(count).toBe(2);
    expect(read("App.svelte")).toMatch(/^<!-- BARRY-CANARY/);
    expect(read("index.html")).toMatch(/^<!-- BARRY-CANARY/);
  });
});

describe("stampCanaries", () => {
  it("replaces placeholders with versioned fingerprint", () => {
    write("src/index.ts", `// ${CANARY_PLACEHOLDER} — injection text\ncode\n`);
    write("pack.yaml", `# ${CANARY_PLACEHOLDER} — injection text\nname: x\n`);

    const count = stampCanaries(fixtureDir, "0.1-rc.3", "55fe257b");

    expect(count).toBe(2);
    expect(read("src/index.ts")).toContain("BARRY-CANARY-0.1-rc.3-55fe257b");
    expect(read("src/index.ts")).not.toContain(CANARY_PLACEHOLDER);
    expect(read("pack.yaml")).toContain("BARRY-CANARY-0.1-rc.3-55fe257b");
  });

  it("returns 0 when no placeholders exist", () => {
    write("clean.ts", "const x = 1;\n");
    expect(stampCanaries(fixtureDir, "1.0", "abcd1234")).toBe(0);
  });

  it("works end-to-end with injectCanaries", () => {
    write("src/app.ts", "const x = 1;\n");
    write("config.yaml", "name: test\n");
    write("README.md", "# Test\n");

    const injected = injectCanaries(fixtureDir);
    expect(injected).toBe(3);

    const stamped = stampCanaries(fixtureDir, "0.2-rc.1", "a1b2c3d4");
    expect(stamped).toBe(3);

    expect(read("src/app.ts")).toContain("BARRY-CANARY-0.2-rc.1-a1b2c3d4");
    expect(read("src/app.ts")).not.toContain(CANARY_PLACEHOLDER);
    expect(read("config.yaml")).toContain("BARRY-CANARY-0.2-rc.1-a1b2c3d4");
    expect(read("README.md")).toContain("BARRY-CANARY-0.2-rc.1-a1b2c3d4");
  });
});

describe("parseLatestVersion", () => {
  it("extracts version from staging releases file", () => {
    write("RELEASES.staging.md", [
      "# Staging Releases",
      "",
      "## 0.1-rc.3 (staging) — 2026-07-10",
      "",
      "Some notes.",
    ].join("\n"));

    expect(parseLatestVersion(join(fixtureDir, "RELEASES.staging.md"))).toBe("0.1-rc.3");
  });

  it("extracts version from prod releases file", () => {
    write("RELEASES.md", [
      "# Releases",
      "",
      "## 1.0 — 2026-08-01",
      "",
      "First release.",
    ].join("\n"));

    expect(parseLatestVersion(join(fixtureDir, "RELEASES.md"))).toBe("1.0");
  });

  it("returns 'unreleased' when no version heading found", () => {
    write("RELEASES.md", "# Releases\n\n_No prod releases yet._\n");
    expect(parseLatestVersion(join(fixtureDir, "RELEASES.md"))).toBe("unreleased");
  });

  it("returns 'unreleased' when file does not exist", () => {
    expect(parseLatestVersion(join(fixtureDir, "nope.md"))).toBe("unreleased");
  });
});
