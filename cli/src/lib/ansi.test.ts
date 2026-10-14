import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  seeli,
  bold, dim, red, green, yellow, blue, magenta, cyan,
  ok, fail, warn, info, spin, bullet, header, line,
} from "./ansi.js";

beforeEach(() => { vi.stubEnv("FORCE_COLOR", "1"); vi.stubEnv("NO_COLOR", ""); });

// Helper: ANSI code builder matching the source
const c = (n: string) => `\x1b[${n}m`;

describe("low-level formatters", () => {
  it("bold wraps with ANSI bold codes", () => {
    expect(bold("hello")).toBe(`${c("1")}hello${c("0")}`);
  });

  it("dim wraps with ANSI dim codes", () => {
    expect(dim("hello")).toBe(`${c("2")}hello${c("0")}`);
  });

  it("colors wrap with correct ANSI codes", () => {
    expect(red("x")).toBe(`${c("31")}x${c("39")}`);
    expect(green("x")).toBe(`${c("32")}x${c("39")}`);
    expect(yellow("x")).toBe(`${c("33")}x${c("39")}`);
    expect(blue("x")).toBe(`${c("34")}x${c("39")}`);
    expect(magenta("x")).toBe(`${c("35")}x${c("39")}`);
    expect(cyan("x")).toBe(`${c("36")}x${c("39")}`);
  });
});

describe("semantic helpers", () => {
  it("ok renders green checkmark", () => {
    expect(ok("done")).toBe(`  ${green("✓")} done`);
  });

  it("fail renders red X", () => {
    expect(fail("bad")).toBe(`  ${red("✗")} bad`);
  });

  it("warn renders yellow bang", () => {
    expect(warn("careful")).toBe(`  ${yellow("!")} careful`);
  });

  it("info renders cyan circle", () => {
    expect(info("note")).toBe(`  ${cyan("○")} note`);
  });

  it("spin renders cyan spinner", () => {
    expect(spin("loading")).toBe(`  ${cyan("⟳")} loading`);
  });

  it("bullet renders dim arrow", () => {
    expect(bullet("item")).toBe(`  ${dim("›")} item`);
  });

  it("header renders bold with newline prefix", () => {
    expect(header("Title")).toBe(`\n${bold("Title")}`);
  });

  it("line renders dim separator", () => {
    expect(line(10)).toBe(dim("──────────"));
    expect(line()).toBe(dim("─".repeat(40)));
  });
});

describe("seeli markdown renderer", () => {
  describe("inline formatting", () => {
    it("renders **bold**", () => {
      expect(seeli("hello **world**")).toBe(`hello ${bold("world")}`);
    });

    it("renders *dim*", () => {
      expect(seeli("hello *world*")).toBe(`hello ${dim("world")}`);
    });

    it("renders `code`", () => {
      expect(seeli("run `npm install`")).toBe(`run ${cyan("npm install")}`);
    });

    it("renders bold and dim in same line", () => {
      const result = seeli("**bold** and *dim*");
      expect(result).toBe(`${bold("bold")} and ${dim("dim")}`);
    });

    it("does not confuse *dim* with **bold**", () => {
      const result = seeli("**bold** then *dim*");
      expect(result).toContain(bold("bold"));
      expect(result).toContain(dim("dim"));
    });
  });

  describe("color tags", () => {
    it("renders <<red>>text<</red>>", () => {
      expect(seeli("<<red>>error<</red>>")).toBe(red("error"));
    });

    it("renders all color tags", () => {
      expect(seeli("<<green>>ok<</green>>")).toBe(green("ok"));
      expect(seeli("<<yellow>>warn<</yellow>>")).toBe(yellow("warn"));
      expect(seeli("<<blue>>info<</blue>>")).toBe(blue("info"));
      expect(seeli("<<magenta>>special<</magenta>>")).toBe(magenta("special"));
      expect(seeli("<<cyan>>code<</cyan>>")).toBe(cyan("code"));
    });

    it("renders <<bold>> and <<dim>> tags", () => {
      expect(seeli("<<bold>>strong<</bold>>")).toBe(bold("strong"));
      expect(seeli("<<dim>>faded<</dim>>")).toBe(dim("faded"));
    });

    it("handles inline markdown inside color tags", () => {
      expect(seeli("<<red>>**critical** error<</red>>")).toBe(red(`${bold("critical")} error`));
    });

    it("handles nested color tags", () => {
      const result = seeli("<<red>>outer <<bold>>inner<</bold>> outer<</red>>");
      expect(result).toBe(red(`outer ${bold("inner")} outer`));
    });

    it("handles multiple color tags on one line", () => {
      const result = seeli("<<green>>pass<</green>> and <<red>>fail<</red>>");
      expect(result).toBe(`${green("pass")} and ${red("fail")}`);
    });

    it("ignores single-angle HTML tags", () => {
      expect(seeli("<div>hello</div>")).toBe("<div>hello</div>");
    });
  });

  describe("block-level syntax", () => {
    it("renders # headers as bold", () => {
      expect(seeli("# Title")).toBe(bold("Title"));
    });

    it("renders ## and ### headers", () => {
      expect(seeli("## Subtitle")).toBe(bold("Subtitle"));
      expect(seeli("### Section")).toBe(bold("Section"));
    });

    it("renders headers with inline formatting", () => {
      expect(seeli("# <<red>>Error<</red>> Report")).toBe(bold(`${red("Error")} Report`));
    });

    it("renders --- as separator line", () => {
      expect(seeli("---")).toBe(line(40));
    });

    it("renders *** and ___ as separator lines", () => {
      expect(seeli("***")).toBe(line(40));
      expect(seeli("___")).toBe(line(40));
    });

    it("renders - list items as bullets", () => {
      expect(seeli("- first")).toBe(bullet("first"));
    });

    it("renders * list items as bullets", () => {
      expect(seeli("* first")).toBe(bullet("first"));
    });

    it("renders list items with inline formatting", () => {
      expect(seeli("- **bold** item")).toBe(bullet(`${bold("bold")} item`));
    });

    it("renders > blockquotes as dim with bar", () => {
      const result = seeli("> some note");
      expect(result).toBe(`  ${dim("│")} ${dim("some note")}`);
    });

    it("renders blockquotes with inline formatting", () => {
      const result = seeli("> with `code`");
      expect(result).toContain(dim("│"));
      expect(result).toContain(cyan("code"));
    });
  });

  describe("checkbox syntax", () => {
    it("[x] renders as green checkmark", () => {
      expect(seeli("[x] done")).toBe(ok("done"));
    });

    it("[ ] renders as cyan circle", () => {
      expect(seeli("[ ] todo")).toBe(info("todo"));
    });

    it("[!] renders as yellow warning", () => {
      expect(seeli("[!] careful")).toBe(warn("careful"));
    });

    it("[~] renders as cyan spinner", () => {
      expect(seeli("[~] loading")).toBe(spin("loading"));
    });

    it("checkboxes support inline formatting", () => {
      expect(seeli("[x] **web** built")).toBe(ok(`${bold("web")} built`));
    });

    it("checkboxes support color tags", () => {
      expect(seeli("[!] <<yellow>>2 changes<</yellow>>")).toBe(warn(yellow("2 changes")));
    });
  });

  describe("multiline rendering", () => {
    it("renders multiple lines", () => {
      const result = seeli("# Title\n---\n[x] done");
      const lines = result.split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe(bold("Title"));
      expect(lines[1]).toBe(line(40));
      expect(lines[2]).toBe(ok("done"));
    });

    it("strips leading and trailing newlines from template literals", () => {
      const result = seeli("\nhello\n");
      expect(result).toBe("hello");
    });

    it("preserves empty lines in the middle", () => {
      const result = seeli("a\n\nb");
      expect(result).toBe("a\n\nb");
    });

    it("passes through plain text unchanged", () => {
      expect(seeli("just some text")).toBe("just some text");
    });
  });

  describe("color environment controls", () => {
    it("disables color when NO_COLOR is set", async () => {
      const orig = process.env.NO_COLOR;
      try {
        process.env.NO_COLOR = "1";
        expect(bold("text")).toBe("text");
      } finally {
        if (orig === undefined) delete process.env.NO_COLOR;
        else process.env.NO_COLOR = orig;
      }
    });

    it("disables color when FORCE_COLOR=0 is set", async () => {
      const orig = process.env.FORCE_COLOR;
      try {
        process.env.FORCE_COLOR = "0";
        expect(bold("text")).toBe("text");
      } finally {
        if (orig === undefined) delete process.env.FORCE_COLOR;
        else process.env.FORCE_COLOR = orig;
      }
    });
  });
});

 it("keeps piped CLI output plain unless FORCE_COLOR is explicit", () => {
  const entry = new URL("../index.ts", import.meta.url).pathname;
  const home = mkdtempSync(join(tmpdir(), "barry-color-"));
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "", HOME: home, BARRY_HOME: join(home, "barry") };
  try {
  delete env.FORCE_COLOR;
  const plain = spawnSync(process.execPath, ["--import", "tsx", entry, "uninstall", "--dry-run"], { encoding: "utf8", env, timeout: 40000 });
  expect(plain.status, plain.stderr).toBe(0);
  expect(plain.stdout).not.toContain("\x1b[");
  const forced = spawnSync(process.execPath, ["--import", "tsx", entry, "uninstall", "--dry-run"], { encoding: "utf8", env: { ...env, FORCE_COLOR: "1" }, timeout: 40000 });
  expect(forced.status, forced.stderr).toBe(0);
  expect(forced.stdout).toContain("\x1b[");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
