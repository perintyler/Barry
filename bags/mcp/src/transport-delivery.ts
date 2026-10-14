import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

interface Frame {
  args: Parameters<Transport["send"]>;
  bytes: number;
  deadline: number;
  resolve(): void;
  reject(error: Error): void;
}

interface DeliveryLimits { messages?: number; bytes?: number; timeoutMs?: number }
const MAX_MESSAGES = 128;
const MAX_BYTES = 16 * 1024 * 1024;

/** Serialize delivery so every queued frame reaches its own fresh authority check. */
export class TransportDelivery {
  private readonly queue: Frame[] = [];
  private readonly controller = new AbortController();
  private readonly write: Transport["send"];
  private readonly maxMessages: number;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private bytes = 0;
  private running = false;

  constructor(transport: Transport, private readonly authorize: () => Promise<boolean>,
    private readonly onRejected: () => void | Promise<void>, limits: DeliveryLimits = {}) {
    this.write = transport.send.bind(transport);
    this.maxMessages = limits.messages ?? MAX_MESSAGES;
    this.maxBytes = limits.bytes ?? MAX_BYTES;
    this.timeoutMs = limits.timeoutMs ?? 10000;
    for (const [value, maximum] of [[this.maxMessages, MAX_MESSAGES], [this.maxBytes, MAX_BYTES], [this.timeoutMs, 60000]] as const) {
      if (!Number.isInteger(value) || value < 1 || value > maximum) throw new RangeError("Invalid delivery limits");
    }
  }

  send(...args: Parameters<Transport["send"]>): Promise<void> {
    if (this.controller.signal.aborted) return Promise.reject(new Error("Transport unavailable"));
    let bytes: number;
    let serialized: string;
    try { serialized = JSON.stringify(args); bytes = Buffer.byteLength(serialized); }
    catch { this.fail(); return Promise.reject(new Error("Transport unavailable")); }
    if (this.queue.length >= this.maxMessages || this.bytes + bytes > this.maxBytes) {
      this.fail();
      return Promise.reject(new Error("Transport unavailable"));
    }
    const snapshot = JSON.parse(serialized) as Parameters<Transport["send"]>;
    if (snapshot[1] === null) snapshot[1] = undefined;
    if (snapshot[1] && args[1]?.onresumptiontoken) snapshot[1].onresumptiontoken = args[1].onresumptiontoken;
    const result = new Promise<void>((resolve, reject) => { this.queue.push({ args: snapshot, bytes, deadline: performance.now() + this.timeoutMs, resolve, reject }); });
    this.bytes += bytes;
    void this.pump();
    return result;
  }

  close(): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    for (const frame of this.queue.splice(0)) frame.reject(new Error("Transport unavailable"));
    this.bytes = 0;
  }

  private fail(): void {
    if (this.controller.signal.aborted) return;
    this.close();
    try { Promise.resolve(this.onRejected()).catch(() => {}); }
    catch { /* Pending delivery is already stopped. */ }
  }

  private async wait<T>(operation: Promise<T>, deadline: number): Promise<T> {
    const signal = this.controller.signal;
    if (signal.aborted || performance.now() >= deadline) {
      operation.catch(() => {});
      throw new Error("Transport unavailable");
    }
    let cancel!: () => void;
    const cancelled = new Promise<never>((_, reject) => { cancel = () => reject(new Error("Transport unavailable")); });
    signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, Math.max(1, deadline - performance.now()));
    try {
      const result = await Promise.race([operation, cancelled]);
      if (signal.aborted || performance.now() >= deadline) throw new Error("Transport unavailable");
      return result;
    } finally { clearTimeout(timer); signal.removeEventListener("abort", cancel); }
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.controller.signal.aborted) {
        const frame = this.queue[0];
        const deadline = frame.deadline;
        try {
          if (!await this.wait(Promise.resolve().then(() => this.authorize()), deadline)) throw new Error("Transport unavailable");
          if (this.controller.signal.aborted) throw new Error("Transport unavailable");
          await this.wait(this.write(...frame.args), deadline);
          frame.resolve();
        } catch { this.fail(); return; }
        this.queue.shift();
        this.bytes -= frame.bytes;
      }
    } finally { this.running = false; }
  }
}
