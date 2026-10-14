import { describe, it, expect } from "vitest";
import {
  PanelRegistry,
  fetchPanel,
  renderPanelShell,
  renderPanelShells,
  type PanelContribution,
} from "./contributed-panels.js";
import { withPanels, PANELS_PLACEHOLDER } from "./pages.js";

const base: PanelContribution = {
  bag: "weather",
  resource: "web",
  id: "forecast",
  title: "Forecast",
  dataPath: "/api/panel",
  page: "/",
  columns: ["Day", "High"],
};

function reg(c: Partial<PanelContribution> = {}) {
  return new PanelRegistry().register({ ...base, ...c });
}

/** A fetch that answers one canned response, or fails one canned way. */
function stubFetch(handler: (url: string) => Promise<Response> | Response): typeof fetch {
  return (url: RequestInfo | URL) => Promise.resolve(handler(String(url)));
}

const resolve = () => "http://127.0.0.1:9999";

describe("panel registration", () => {
  it("rejects a second claim on one key, naming it", () => {
    const r = new PanelRegistry();
    r.register(base);
    expect(() => r.register(base)).toThrow(/weather\.forecast.*already registered/);
  });

  // Validate contributed IDs because DOM IDs and path segments cannot safely contain arbitrary markup.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-023
  it("refuses ids and bags that are not safe identifiers", () => {
    expect(() => reg({ id: '"><script>' })).toThrow(/not a safe id/);
    expect(() => reg({ id: "Has Capitals" })).toThrow(/not a safe id/);
    expect(() => reg({ bag: "../../etc" })).toThrow(/not a safe id/);
  });

  // Contributors name paths on their own origin; reject scheme-relative paths that escape it.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-024
  it("refuses a dataPath that could leave the bag's own origin", () => {
    expect(() => reg({ dataPath: "//evil.example/x" })).toThrow(/rooted path/);
    expect(() => reg({ dataPath: "http://evil.example/x" })).toThrow(/rooted path/);
    expect(() => reg({ dataPath: "/a/../../b" })).toThrow(/rooted path/);
    expect(() => reg({ dataPath: "relative" })).toThrow(/rooted path/);
  });

  it("refuses a panel with no title or no columns", () => {
    expect(() => reg({ title: "  " })).toThrow(/no title/);
    expect(() => reg({ columns: [] })).toThrow(/no columns/);
  });

  it("groups panels by host page", () => {
    const r = new PanelRegistry();
    r.register(base);
    r.register({ ...base, id: "radar", page: "/jobs" });
    expect(r.forPage("/").map((p) => p.id)).toEqual(["forecast"]);
    expect(r.forPage("/jobs").map((p) => p.id)).toEqual(["radar"]);
    expect(r.forPage("/cost")).toEqual([]);
  });
});

describe("a contributor that is down", () => {
  // Contributor failures return unavailable rather than falsely claiming an empty measured panel.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-025
  it("renders unavailable with a reason, never empty, for every failure mode", async () => {
    const cases: Array<[string, () => Promise<unknown>, RegExp]> = [
      [
        "bag not in the resource registry",
        () => fetchPanel(reg(), () => { throw new Error("no URL registered for weather.web"); }, stubFetch(() => new Response())),
        /not in the bag resource registry/,
      ],
      [
        "connection refused",
        () => fetchPanel(reg(), resolve, stubFetch(() => Promise.reject(new TypeError("fetch failed")))),
        /unreachable.*Is the service running\?/,
      ],
      [
        "http error",
        () => fetchPanel(reg(), resolve, stubFetch(() => new Response("nope", { status: 503 }))),
        /answered HTTP 503/,
      ],
      [
        "html instead of json",
        () => fetchPanel(reg(), resolve, stubFetch(() => new Response("<html>", { headers: { "content-type": "text/html" } }))),
        /not JSON/,
      ],
      [
        "json that is not a panel",
        () => fetchPanel(reg(), resolve, stubFetch(() => Response.json({ rows: [] }))),
        /malformed panel/,
      ],
      [
        "ok with the wrong data shape",
        () => fetchPanel(reg(), resolve, stubFetch(() => Response.json({ state: "ok", data: [{ a: 1 }] }))),
        /not an array of string arrays/,
      ],
      [
        "unavailable with no reason given",
        () => fetchPanel(reg(), resolve, stubFetch(() => Response.json({ state: "unavailable" }))),
        /unavailable without a reason/,
      ],
    ];

    for (const [name, run, expected] of cases) {
      const panel = (await run()) as { state: string; reason?: string };
      expect(panel.state, name).toBe("unavailable");
      expect(panel.reason, name).toMatch(expected);
      // The bag is named, so a reader knows WHOSE panel is down.
      expect(panel.reason, name).toContain("weather");
    }
  });

  it("gives up on a contributor that accepts and never answers", async () => {
    const hang = stubFetch(() => new Promise<Response>(() => {}));
    const panel = await fetchPanel(
      reg({ timeoutMs: 20 }),
      resolve,
      (url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_, rej) => {
          init?.signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            rej(e);
          });
        }),
    );
    expect(panel.state).toBe("unavailable");
    expect(panel.state === "unavailable" && panel.reason).toMatch(/did not answer .* within 20ms/);
    void hang;
  });

  /** `fetchPanel` is the route's only error handling; it must not throw. */
  it("never rejects, whatever the transport does", async () => {
    const boom = stubFetch(() => { throw new Error("synchronous explosion"); });
    await expect(fetchPanel(reg(), resolve, boom)).resolves.toMatchObject({ state: "unavailable" });
  });
});

describe("a contributor that works", () => {
  it("passes ok, empty and partial through, distinctly", async () => {
    const ok = await fetchPanel(reg(), resolve, stubFetch(() => Response.json({ state: "ok", data: [["Mon", "20"]] })));
    expect(ok).toMatchObject({ state: "ok", data: [["Mon", "20"]] });

    const empty = await fetchPanel(reg(), resolve, stubFetch(() => Response.json({ state: "empty", explanation: "no readings today" })));
    expect(empty).toEqual({ state: "empty", explanation: "no readings today" });

    const partial = await fetchPanel(reg(), resolve, stubFetch(() => Response.json({ state: "partial", data: [["Mon", "20"]], caveat: "one station offline" })));
    expect(partial).toMatchObject({ state: "partial", caveat: "one station offline" });
  });

  /** A contributor's self-reported timing cannot hide its own slowness. */
  it("times the panel by the host's clock, not the contributor's claim", async () => {
    const ok = await fetchPanel(reg(), resolve, stubFetch(() => Response.json({ state: "ok", data: [], ms: 999999 })));
    expect(ok.state).toBe("ok");
    // The contributor claimed 999999ms; the host overrides it with what it
    // actually measured, so a panel cannot misreport its own latency.
    expect(ok.state === "ok" ? ok.ms : -1).toBeLessThan(1000);
  });

  it("resolves the endpoint through the registry rather than a fixed port", async () => {
    let called = "";
    await fetchPanel(
      reg({ dataPath: "/api/panel?x=1" }),
      (bag, resource) => {
        expect([bag, resource]).toEqual(["weather", "web"]);
        return "http://127.0.0.1:7777";
      },
      stubFetch((url) => { called = url; return Response.json({ state: "ok", data: [] }); }),
    );
    expect(called).toBe("http://127.0.0.1:7777/api/panel?x=1");
  });
});

describe("contributed text reaching HTML", () => {
  // Escape contributor titles as text so contributions cannot inject elements.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-026
  // Validate disk-supplied panel descriptors at runtime; TypeScript cannot check JSON contributions.
  // Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-039
  it("names the missing field rather than throwing on undefined", () => {
    const { page: _p, ...noPage } = reg();
    expect(() => new PanelRegistry().register(noPage as never)).toThrow(/missing a string "page"/);

    const { columns: _c, ...noColumns } = reg();
    expect(() => new PanelRegistry().register(noColumns as never)).toThrow(/missing "columns"/);
  });

  it("rejects columns that are not an array of strings", () => {
    expect(() => new PanelRegistry().register({ ...reg(), columns: "Roast" } as never))
      .toThrow(/missing "columns"/);
    expect(() => new PanelRegistry().register({ ...reg(), columns: [1, 2] } as never))
      .toThrow(/non-string column header/);
  });

  it("escapes a title and column headers that try to be markup", () => {
    const html = renderPanelShell(reg({ title: '</h2><script>alert(1)</script>', columns: ['<img src=x onerror=1>'] }));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=1&gt;");
  });

  it("renders a loading state, never an empty table", () => {
    const html = renderPanelShell(reg());
    // An empty <tbody> here would be a table of no rows before any fetch has
    // happened — indistinguishable from a contributor that returned nothing.
    expect(html).toContain("loading");
    expect(html).not.toContain("<tbody>");
  });

  it("contributes nothing at all when no panel targets the page", () => {
    expect(renderPanelShells([])).toBe("");
  });
});

describe("placing panels in a host page", () => {
  const page = "<body><main>\n  <section>host</section>\n</main></body>";

  /** No marker needed: this is what makes a contribution need no edit here. */
  it("appends inside </main> when the page has no marker", () => {
    const out = withPanels(page, "\n  <section>theirs</section>\n");
    expect(out).toBe("<body><main>\n  <section>host</section>\n\n  <section>theirs</section>\n</main></body>");
    expect(out.indexOf("host")).toBeLessThan(out.indexOf("theirs"));
  });

  it("honours an explicit marker when a page names the spot", () => {
    const marked = `<main><section>host</section>${PANELS_PLACEHOLDER}</main>`;
    expect(withPanels(marked, "X")).toBe("<main><section>host</section>X</main>");
  });

  // With no contributions, page bytes remain identical to the original host document.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-027
  it("returns the page untouched when there is nothing to contribute", () => {
    expect(withPanels(page, "")).toBe(page);
  });

  it("returns the page untouched rather than throwing when there is no main", () => {
    expect(withPanels("<p>hi</p>", "X")).toBe("<p>hi</p>");
  });
});
