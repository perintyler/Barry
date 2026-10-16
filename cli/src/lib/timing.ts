/** Process-relative launch timings. Keep this module independent of Barry packages. */
export const timingEnabled = process.env.BARRY_TIMING === "1";

export function createTiming(enabled: boolean, write: (text: string) => void = text => { process.stderr.write(text); }) {
  const entries: Array<{ name: string; start: number; duration: number; user?: boolean }> = [];
  let reported = false;
  function mark(name: string): void {
    if (!enabled) return;
    const now = performance.now();
    performance.mark(name);
    entries.push({ name, start: now, duration: 0, ...(name === "session:selection" ? { user: true } : {}) });
  }
  function begin(name: string, user = false): () => void {
    if (!enabled) return () => {};
    const start = performance.now();
    return () => entries.push({ name, start, duration: performance.now() - start, ...(user ? { user: true } : {}) });
  }
  async function span<T>(name: string, run: () => Promise<T>): Promise<T> {
    if (!enabled) return run();
    const start = performance.now();
    performance.mark(`${name}:start`);
    try { return await run(); }
    finally {
      const end = performance.now();
      performance.mark(`${name}:end`);
      performance.measure(name, `${name}:start`, `${name}:end`);
      entries.push({ name, start, duration: end - start });
    }
  }
  function report(reason: string): void {
    if (!enabled || reported) return;
    reported = true;
    const early = performance.getEntriesByType("mark").filter(entry => entry.name.startsWith("bin:"));
    write(`Barry timing (${reason}) — entry: ${process.env.BARRY_TIMING_ENTRY ?? "tsx"}\n` +
      "stage                             start ms    dur ms\n" +
      [...early.map(entry => ({ name: entry.name, start: entry.startTime, duration: 0 })), ...entries]
        .sort((a, b) => a.start - b.start)
        .map(entry => `${entry.name.padEnd(33)} ${entry.start.toFixed(1).padStart(9)} ${entry.duration.toFixed(1).padStart(9)}${"user" in entry ? " (user time)" : ""}`).join("\n") + "\n");
  }
  function server(value: unknown): void {
    if (enabled && value != null) write(`Barry server timing: ${typeof value === "string" ? value : JSON.stringify(value)}\n`);
  }
  return { mark, span, begin, report, server };
}
const timing = createTiming(timingEnabled);
export const { mark, span, begin, report, server: reportServerTiming } = timing;
if (timingEnabled) process.once("exit", () => {
  if (process.env.BARRY_TIMING_HOOK === "1") process.stderr.write(`Barry hook total: ${performance.now().toFixed(1)} ms\n`);
  else report("exit");
});
