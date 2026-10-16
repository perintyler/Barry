/** Numeric timings shared by the HTTP, WebSocket and log views. */
export type SessionTimings = Record<string, number>;
export async function timed<T>(timings: SessionTimings, name: string, run: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try { return await run(); }
  finally { timings[name] = performance.now() - start; }
}
export function timingHeader(timings: SessionTimings): string {
  return Object.entries(timings).map(([name, value]) => `${name === "warm_hit" ? "warm" : name.replace(/_ms$/, "")}=${Number.isFinite(value) ? value.toFixed(name === "warm_hit" ? 0 : 1) : "0"}`).join(";");
}

/** Startup happened during prepare, so the message header must not report it as turn work. */
export function messageTimingHeader(timings: SessionTimings, wasWarm: boolean): string {
  const turn: SessionTimings = { ...timings, warm_hit: wasWarm ? 1 : 0 };
  if (wasWarm) { delete turn.harness_create_ms; delete turn.harness_ready_ms; }
  return timingHeader(turn);
}
