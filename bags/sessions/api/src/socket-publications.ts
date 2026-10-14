import type { CredentialAuthorization } from "@barry-rocks/sdk/internal/auth";

interface PublicationTransport {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string, callback: (error?: Error) => void): void;
  close(code: number, reason: string): void;
  on(event: "close" | "error", listener: () => void): unknown;
}
interface Publication { data: string; bytes: number }

/** Legacy publishers share one bounded queue and reverify before every native send. */
export class SocketPublications {
  private readonly queue: Publication[] = [];
  private readonly controller = new AbortController();
  private bytes = 0;
  private pumping = false;
  private closed = false;
  private current: Publication | undefined;
  private readonly maxBytes: number;
  private readonly maxFrames: number;

  constructor(private readonly socket: PublicationTransport, private readonly authorization: CredentialAuthorization,
    options: { maxBytes?: number; maxFrames?: number } = {}) {
    this.maxBytes = options.maxBytes ?? 1024 * 1024;
    this.maxFrames = options.maxFrames ?? 128;
    if (authorization.principal.kind !== "installation") throw new Error("Installation publication authorization required");
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > 16 * 1024 * 1024
      || !Number.isSafeInteger(this.maxFrames) || this.maxFrames < 1 || this.maxFrames > 4096) throw new RangeError("Invalid publication queue limits");
    socket.on("close", () => this.dispose());
    socket.on("error", () => this.dispose());
  }
  get readyState(): number { return this.closed ? 3 : this.socket.readyState; }
  get bufferedAmount(): number { return this.bytes + this.socket.bufferedAmount; }

  send(data: string): boolean {
    if (this.closed || this.socket.readyState !== 1) return false;
    const bytes = Buffer.byteLength(data);
    if (this.bufferedAmount + bytes > this.maxBytes || this.queue.length + (this.current ? 1 : 0) >= this.maxFrames) {
      this.close(1013, "Consumer is behind; reconnect"); return false;
    }
    this.queue.push({ data, bytes }); this.bytes += bytes;
    void this.pump();
    return true;
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true; this.controller.abort();
    this.queue.length = 0; this.bytes = 0; this.current = undefined;
    this.authorization.dispose();
  }
  private close(code: number, reason: string): void {
    if (this.closed) return;
    this.dispose(); this.socket.close(code, reason);
  }
  private async pump(): Promise<void> {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      while (this.queue.length && !this.closed) {
        this.current = this.queue.shift()!;
        const allowed = await this.authorization.revalidate(this.controller.signal);
        if (this.closed) return;
        if (!allowed) { this.close(1008, "Authorization unavailable"); return; }
        if (this.socket.readyState !== 1) { this.dispose(); return; }
        const current = this.current;
        await new Promise<void>((resolve, reject) => {
          const cancel = () => { this.controller.signal.removeEventListener("abort", cancel); reject(new Error("Publication cancelled")); };
          this.controller.signal.addEventListener("abort", cancel, { once: true });
          try {
            this.socket.send(current.data, error => {
              this.controller.signal.removeEventListener("abort", cancel);
              if (error) reject(error); else resolve();
            });
          } catch (error) { this.controller.signal.removeEventListener("abort", cancel); reject(error instanceof Error ? error : new Error(String(error))); }
        });
        if (this.closed) return;
        this.bytes -= current.bytes; this.current = undefined;
      }
    } catch { if (!this.closed) this.close(1011, "Publication failed"); }
    finally { this.pumping = false; }
  }
}
