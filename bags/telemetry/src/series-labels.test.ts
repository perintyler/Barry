import { describe, expect, it } from "vitest";
import { parseLabelsParam } from "./series-labels.js";

/**
 * BAG-22: /api/series parsed its `labels` query parameter with
 * `JSON.parse(...) as Record<string,string>`. Malformed JSON threw (→ 500) and
 * non-string values were asserted, not checked. The route now validates and
 * answers 400.
 */
describe("parseLabelsParam (BAG-22)", () => {
  it("accepts an absent parameter as 'no labels'", () => {
    expect(parseLabelsParam(null)).toEqual({ ok: true, labels: undefined });
    expect(parseLabelsParam("")).toEqual({ ok: true, labels: undefined });
  });

  it("accepts a flat object of string values", () => {
    expect(parseLabelsParam('{"service":"api","host":"a"}')).toEqual({
      ok: true,
      labels: { service: "api", host: "a" },
    });
  });

  it("rejects malformed JSON instead of throwing a 500", () => {
    const r = parseLabelsParam("{not json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/string values/);
  });

  it("rejects a JSON array", () => {
    expect(parseLabelsParam('["service","api"]').ok).toBe(false);
  });

  it("rejects non-string values that the old assertion would have let through", () => {
    expect(parseLabelsParam('{"service":1}').ok).toBe(false);
    expect(parseLabelsParam('{"service":{"nested":"x"}}').ok).toBe(false);
    expect(parseLabelsParam('{"service":null}').ok).toBe(false);
  });

  it("rejects a bare JSON scalar", () => {
    expect(parseLabelsParam('"api"').ok).toBe(false);
    expect(parseLabelsParam("42").ok).toBe(false);
  });
});
