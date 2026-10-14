/** Keep a workflow bearer private and stop late verification from granting authority. */
export class WorkflowAuthorization {
  private token: string | undefined;
  private readonly lifetime = new AbortController();

  constructor(token: string, private readonly verify: (token: string, signal: AbortSignal) => Promise<void>,
    private readonly timeoutMs = 5000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new RangeError("Invalid authorization timeout");
    this.token = token;
  }

  dispose(): void { this.token = undefined; this.lifetime.abort(); }

  async check(signal?: AbortSignal): Promise<boolean> {
    const token = this.token;
    if (!token || this.lifetime.signal.aborted || signal?.aborted) return false;
    const controller = new AbortController();
    const deadline = performance.now() + this.timeoutMs;
    const active = () => {
      if (performance.now() >= deadline) controller.abort();
      return !controller.signal.aborted;
    };
    const cancel = () => controller.abort();
    this.lifetime.signal.addEventListener("abort", cancel, { once: true });
    signal?.addEventListener("abort", cancel, { once: true });
    let aborted!: () => void;
    const cancelled = new Promise<boolean>(resolve => {
      aborted = () => resolve(false);
      controller.signal.addEventListener("abort", aborted, { once: true });
    });
    const timer = setTimeout(cancel, this.timeoutMs);
    try {
      return await Promise.race([Promise.resolve().then(async () => {
        if (!active()) return false;
        await this.verify(token, controller.signal);
        return active();
      }), cancelled]);
    } catch { return false; }
    finally {
      controller.abort();
      clearTimeout(timer);
      this.lifetime.signal.removeEventListener("abort", cancel);
      signal?.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", aborted);
    }
  }
}
