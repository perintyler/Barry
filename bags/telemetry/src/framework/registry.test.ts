import { describe, it, expect } from "vitest";
import { TelemetryRegistry } from "./registry.js";
import { METRICS } from "../schema.js";
import { DEFAULT_RULES } from "../rules.js";
import type { Rule } from "../rules.js";

const rule = (over: Partial<Rule> = {}): Rule => ({
  id: "r", kind: "threshold", metric: "m", limit: 1,
  severity: "warn", message: "m", rationale: "because", ...over,
});

describe("TelemetryRegistry", () => {
  it("merges a contributor's metrics with the built-ins", () => {
    const r = new TelemetryRegistry();
    r.seedMetrics("metrics", Object.values(METRICS));
    r.register({ bag: "coffee", metrics: [{ name: "coffee.cups", unit: "count", description: "d" }] });

    expect(r.metrics()).toHaveLength(Object.values(METRICS).length + 1);
    expect(r.bagOfMetric("coffee.cups")).toBe("coffee");
    expect(r.bagOfMetric(METRICS.serviceUp.name)).toBe("metrics");
  });

  // Reject duplicate metric ownership at registration rather than emitting ambiguous data.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-042
  it("rejects a metric name already claimed, naming both bags", () => {
    const r = new TelemetryRegistry();
    r.seedMetrics("metrics", Object.values(METRICS));
    expect(() =>
      r.register({ bag: "impostor", metrics: [{ name: METRICS.serviceUp.name, unit: "bool", description: "d" }] }),
    ).toThrow(/already registered by "metrics".*"impostor"/s);
  });

  it("rejects a duplicate rule id", () => {
    const r = new TelemetryRegistry();
    r.register({ bag: "a", rules: [rule({ id: "dupe" })] });
    expect(() => r.register({ bag: "b", rules: [rule({ id: "dupe" })] })).toThrow(/already registered by "a"/);
  });

  // Require rule rationale at registration so unexplained alerts cannot become silently muted monitoring.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-043
  it("refuses a rule with no rationale", () => {
    const r = new TelemetryRegistry();
    expect(() => r.register({ bag: "a", rules: [rule({ rationale: "  " })] })).toThrow(/no rationale/);
  });

  /** Every shipped rule must survive registration, or the gate is theatre. */
  it("accepts every rule this bag already ships", () => {
    const r = new TelemetryRegistry();
    expect(() => r.register({ bag: "metrics", rules: DEFAULT_RULES })).not.toThrow();
    expect(r.rules()).toHaveLength(DEFAULT_RULES.length);
  });

  // Isolate contributed collector failures and attribute each failure to its owning bag.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-044
  it("isolates a failing collector and names the bag", async () => {
    const r = new TelemetryRegistry();
    r.register({ bag: "good", collect: async () => [{ ts: 1, metric: "g", value: 1 }] });
    r.register({ bag: "bad", collect: async () => { throw new Error("nope"); } });

    const { points, failed } = await r.collectAll();
    expect(points).toHaveLength(1);
    expect(failed).toEqual(["bad"]);
  });

  // A contribution must register its metric, rule and collector without editing host code.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-045
  it("accepts a complete third-party contribution", async () => {
    const r = new TelemetryRegistry();
    r.seedMetrics("metrics", Object.values(METRICS));
    r.register({
      bag: "coffee",
      metrics: [{ name: "coffee.pot.temp_c", unit: "C", description: "Pot temperature" }],
      rules: [rule({ id: "pot-cold", metric: "coffee.pot.temp_c", rationale: "cold coffee is a real outage" })],
      collect: async () => [{ ts: 1, metric: "coffee.pot.temp_c", value: 82 }],
    });

    expect(r.bagOfMetric("coffee.pot.temp_c")).toBe("coffee");
    expect(r.rules().map((x) => x.id)).toContain("pot-cold");
    expect((await r.collectAll()).points[0].value).toBe(82);
  });
});
