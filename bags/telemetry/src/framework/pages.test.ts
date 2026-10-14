import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PAGES, renderNav, withNav, NAV_PLACEHOLDER } from "./pages.js";

const WEB = join(import.meta.dirname, "..", "..", "web");

describe("page registry", () => {
  it("marks exactly one link active, and only for a real page", () => {
    for (const p of PAGES) {
      const nav = renderNav(p.path);
      expect(nav.match(/aria-current="page"/g) ?? []).toHaveLength(1);
      expect(nav).toContain(`<a href="${p.path}" aria-current="page">`);
    }
    // An unknown path is not an error — it renders a nav with nothing active,
    // which is what a 404 or a contributed page not yet in the list should do.
    expect(renderNav("/nope")).not.toContain("aria-current");
  });

  // Page files and central registration must agree in both directions.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-036
  it("matches the files in web/ exactly", () => {
    const onDisk = readdirSync(WEB).filter((f) => f.endsWith(".html")).sort();
    expect(PAGES.map((p) => p.file).sort()).toEqual(onDisk);
  });

  // Generated navigation replaces every marker; retained literal navigation would silently drift.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-037
  it("leaves no hand-written nav in any page", () => {
    for (const p of PAGES) {
      const html = readFileSync(join(WEB, p.file), "utf8");
      expect(html, p.file).not.toContain("<nav>");
      expect(html, p.file).toContain(NAV_PLACEHOLDER);
    }
  });

  // Infrastructure deliberately has no empty time-window control because it has no windowed view.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-038
  it("renders the window selector only where a script drives it", () => {
    expect(renderNav("/")).not.toContain('id="windows"');
    expect(renderNav("/metrics")).toContain('id="windows"');
  });

  it("returns html unchanged when the marker is absent", () => {
    expect(withNav("<p>hi</p>", "/")).toBe("<p>hi</p>");
  });
});
