// Validate extension contracts and reject collisions at the registry boundary.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-061

import type { MetricPoint } from "../schema.js";
import type { Rule } from "../rules.js";

/** A metric descriptor, matching the shape of `METRICS` entries. */
export interface MetricDescriptor {
  name: string;
  unit: string;
  description: string;
}

/** Everything a contributor supplies, in one declaration. */
export interface Contribution {
  /** The contributing bag. Used to attribute failures and namespace panels. */
  bag: string;
  /** Metric descriptors this bag will write. */
  metrics?: MetricDescriptor[];
  // Every rule requires rationale so operators can assess a firing instead of muting unexplained noise.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-046
  rules?: Rule[];
  // Contributed collectors must emit health even when their measured dependency fails.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-047
  collect?: () => Promise<MetricPoint[]>;
}

export interface Registered<T> {
  bag: string;
  value: T;
}

// One live registry supplies every extension point; duplicated registries would hide contributions.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-062
export class TelemetryRegistry {
  private readonly metricsByName = new Map<string, Registered<MetricDescriptor>>();
  private readonly rulesById = new Map<string, Registered<Rule>>();
  private readonly collectors: Array<Registered<() => Promise<MetricPoint[]>>> = [];

  // Seed built-in descriptors so contributions cannot shadow their metric names.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-048
  seedMetrics(bag: string, descriptors: MetricDescriptor[]): void {
    for (const d of descriptors) this.addMetric(bag, d);
  }

  /** Register one bag's contribution. Throws on the first collision. */
  register(c: Contribution): void {
    for (const d of c.metrics ?? []) this.addMetric(c.bag, d);
    for (const r of c.rules ?? []) this.addRule(c.bag, r);
    if (c.collect) this.collectors.push({ bag: c.bag, value: c.collect });
  }

  private addMetric(bag: string, d: MetricDescriptor): void {
    const held = this.metricsByName.get(d.name);
    if (held) {
      throw new Error(
        `metric "${d.name}" already registered by "${held.bag}"; "${bag}" cannot also claim it`,
      );
    }
    this.metricsByName.set(d.name, { bag, value: d });
  }

  private addRule(bag: string, r: Rule): void {
    const held = this.rulesById.get(r.id);
    if (held) {
      throw new Error(
        `rule "${r.id}" already registered by "${held.bag}"; "${bag}" cannot also claim it`,
      );
    }
    // The alert-state key is the rule id, so a rule with no rationale is both
    // unexplainable and indistinguishable from another bag's rule of the same
    // name — refuse it here rather than at fire time.
    if (!r.rationale?.trim()) {
      throw new Error(`rule "${r.id}" from "${bag}" has no rationale`);
    }
    this.rulesById.set(r.id, { bag, value: r });
  }

  metrics(): MetricDescriptor[] {
    return [...this.metricsByName.values()].map((m) => m.value);
  }

  rules(): Rule[] {
    return [...this.rulesById.values()].map((r) => r.value);
  }

  /** Which bag supplied a metric, for attributing a bad series. */
  bagOfMetric(name: string): string | undefined {
    return this.metricsByName.get(name)?.bag;
  }

  // Isolate contributed collector failures so one bag cannot prevent other readings.
  // Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-063
  async collectAll(): Promise<{ points: MetricPoint[]; failed: string[] }> {
    const settled = await Promise.allSettled(this.collectors.map((c) => c.value()));
    const points: MetricPoint[] = [];
    const failed: string[] = [];
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") points.push(...r.value);
      else failed.push(this.collectors[i].bag);
    });
    return { points, failed };
  }
}
