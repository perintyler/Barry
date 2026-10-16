/** All marks use the server's monotonic clock, relative to POST ingress. */
export class TurnTimer {
  private readonly marks: Record<string, number> = {};
  private readonly samples = new Map<string, number[]>();
  private previousFrame?: number;
  private previousQueuedAt=-Infinity;
  private previousModelEvent?:number;
  private previousKind?:string;
  private readonly counts: Record<string, number> = {};
  constructor(readonly ingressAt = performance.now(), private readonly now = () => performance.now()) {}
  mark(name: string): void { this.marks[name] = this.now() - this.ingressAt; }
  first(name: string): void { if (this.marks[name] === undefined) this.mark(name); }
  sample(name: string, value: number): void {
    const values = this.samples.get(name) ?? [];
    if (values.length === 4096) values.shift();
    values.push(value); this.samples.set(name, values);
  }
  count(name: string, by = 1): void { this.counts[name] = (this.counts[name] ?? 0) + by; }
  async measure<T>(name: string, run: () => Promise<T>): Promise<T> {
    const start = this.now();
    try { return await run(); } finally { this.marks[name] = this.now() - start; }
  }
  event(type: string): void {
    if(["tool_start","tool_result","tool_use","text"].includes(type)||(type==="partial"&&this.previousKind!=="partial")){this.previousModelEvent=undefined;this.previousFrame=undefined;}
    this.previousKind=type;
    this.first("first_event_ms");
    if (type==="partial" || type==="thinking") {
      const now=this.now();if(this.previousModelEvent!==undefined)this.sample("model_gap",now-this.previousModelEvent);
      this.previousModelEvent=now;
    }
    if (type === "thinking") this.first("first_thinking_ms");
    if (type === "partial" || type === "text") this.first("first_token_ms");
  }
  sent(bytes: number, queuedAt: number, streaming = true): void {
    const now = this.now();
    this.count("frames"); this.count("bytes", bytes);
    this.sample("ws_send", now - queuedAt);
    // Count physical fan-out bytes, but take the gap only on the first native
    // send of a logical event. A second subscriber is not another model chunk.
    if (!streaming || queuedAt<=this.previousQueuedAt) return;
    this.previousQueuedAt=queuedAt;
    if (this.previousFrame !== undefined) this.sample("gap", now - this.previousFrame);
    this.previousFrame = now;
  }
  summary(): Record<string, number> {
    const result = { ...this.marks, ...this.counts };
    for (const [name, values] of this.samples) {
      const sorted = [...values].sort((a, b) => a - b);
      for (const [suffix, q] of [["p50", .5], ["p95", .95], ["max", 1]] as const) {
        result[`${name}_${suffix}_ms`] = sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] ?? 0;
      }
    }
    return result;
  }
}
