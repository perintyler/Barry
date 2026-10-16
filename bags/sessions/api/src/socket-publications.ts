import type { CredentialAuthorization } from "@barry-rocks/sdk/internal/auth";

interface PublicationTransport {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string, callback: (error?: Error) => void): void;
  cork?(): void;
  uncork?(): void;
  close(code: number, reason: string): void;
  on(event: "close" | "error", listener: () => void): unknown;
}
export interface PublicationReceipt { bytes?:number; queuedAt?:number; coalesced?:number; skipPhysical?:boolean; queueWaitMs?:number; sendCallbackMs?:number }
type Sent=(receipt?:PublicationReceipt)=>void;
interface Publication { data: string; bytes: number; queuedAt: number; onSent?: Sent; callbacks?: Sent[] }

/** Legacy publishers share one bounded queue and reverify before every native send. */
export class SocketPublications {
  private readonly queue: Publication[] = [];
  private readonly controller = new AbortController();
  private bytes = 0;
  private pumping = false;
  private closed = false;
  private current: Publication | undefined;
  private inFlight=0;
  private lastRevalidatedAt = -Infinity;
  private invalidation = 0;
  private readonly maxBytes: number;
  private readonly maxFrames: number;
  private readonly onSent?: (bytes: number, queuedAt: number) => void;

  constructor(private readonly socket: PublicationTransport, private readonly authorization: CredentialAuthorization,
    options: { maxBytes?: number; maxFrames?: number; onSent?: (bytes: number, queuedAt: number) => void } = {}) {
    this.onSent = options.onSent;
    this.maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
    this.maxFrames = options.maxFrames ?? 512;
    if (authorization.principal.kind !== "installation") throw new Error("Installation publication authorization required");
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > 16 * 1024 * 1024
      || !Number.isSafeInteger(this.maxFrames) || this.maxFrames < 1 || this.maxFrames > 4096) throw new RangeError("Invalid publication queue limits");
    socket.on("close", () => this.dispose());
    socket.on("error", () => this.dispose());
  }
  get readyState(): number { return this.closed ? 3 : this.socket.readyState; }
  get bufferedAmount(): number { return this.bytes + this.socket.bufferedAmount; }

  invalidateAuthorization(): void { this.lastRevalidatedAt=-Infinity; this.invalidation++; }
  send(data: string): boolean { return this.publish(data); }
  publish(data: string, onSent?: Sent): boolean {
    if (this.closed || this.socket.readyState !== 1) return false;
    const bytes = Buffer.byteLength(data);
    // Only adjacent deltas may merge: never cross a tool/status/durable frame.
    if (this.queue.length >= 32 || this.bytes >= 256*1024) {
      const previous=this.queue.at(-1);
      if (previous) try {
        const a=JSON.parse(previous.data), b=JSON.parse(data);
        if ((b.type==="partial" || b.type==="thinking") && a.type===b.type && a.sessionId===b.sessionId && a.parentToolUseId===b.parentToolUseId && a.sequence===undefined && b.sequence===undefined) {
          const merged=JSON.stringify({...a,content:(a.content??"")+(b.content??"")});
          const delta=Buffer.byteLength(merged)-previous.bytes;
          if (this.bufferedAmount+delta<=this.maxBytes) {
            this.bytes+=delta; previous.bytes+=delta; previous.data=merged;
            if (onSent) (previous.callbacks??=[]).push(onSent);
            return true;
          }
        }
      } catch { /* Other publications keep their ordinary ordering. */ }
    }
    if (this.bufferedAmount + bytes > this.maxBytes || this.queue.length + this.inFlight + (this.current && !this.inFlight ? 1 : 0) >= this.maxFrames) {
      this.close(1013, "Consumer is behind; reconnect"); return false;
    }
    this.queue.push({ data, bytes, queuedAt: performance.now(), onSent }); this.bytes += bytes;
    void this.pump();
    return true;
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true; this.controller.abort();
    this.queue.length = 0; this.bytes = 0; this.current = undefined; this.inFlight=0;
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
        let allowed=true;
        const streaming=(data:string)=>{try {return ["partial","thinking"].includes(JSON.parse(data).type);} catch{return false;}};
        if (!streaming(this.current.data) || performance.now()-this.lastRevalidatedAt>1000) {
          const version=this.invalidation;
          allowed=await this.authorization.revalidate(this.controller.signal);
          if (version!==this.invalidation) { this.queue.unshift(this.current); this.current=undefined; continue; }
          this.lastRevalidatedAt=performance.now();
        }
        if (this.closed) return;
        if (!allowed) { this.close(1008, "Authorization unavailable"); return; }
        if (this.socket.readyState !== 1) { this.dispose(); return; }
        const batch=[this.current];
        if (this.socket.cork && this.socket.uncork && streaming(this.current.data)) {
          while (this.queue.length && streaming(this.queue[0]!.data)) batch.push(this.queue.shift()!);
        }
        const version=this.invalidation;
        const send=(current: Publication) => new Promise<void>((resolve,reject)=>{
          const cancel=()=>{this.controller.signal.removeEventListener("abort",cancel);reject(new Error("Publication cancelled"));};
          this.controller.signal.addEventListener("abort",cancel,{once:true});
          const sendAt=performance.now();
          try {
            this.inFlight++;
            this.socket.send(current.data,error=>{
              this.controller.signal.removeEventListener("abort",cancel);
              if (error) {reject(error);return;}
              if (!this.closed) {
                this.inFlight--;
                current.onSent?.({bytes:current.bytes,queuedAt:current.queuedAt,coalesced:current.callbacks?.length??0,queueWaitMs:sendAt-current.queuedAt,sendCallbackMs:performance.now()-sendAt});
                for (const callback of current.callbacks??[]) callback({skipPhysical:true});
                this.onSent?.(current.bytes,current.queuedAt); this.bytes-=current.bytes;
              }
              resolve();
            });
          } catch(error) {this.controller.signal.removeEventListener("abort",cancel);reject(error);}
        });
        const completions:Promise<void>[]=[];
        this.socket.cork?.();
        try {
          for (let i=0;i<batch.length;i++) {
            if (version!==this.invalidation || this.closed) {this.queue.unshift(...batch.slice(i));break;}
            completions.push(send(batch[i]!));
          }
        } finally {this.socket.uncork?.();}
        await Promise.all(completions);
        this.current=undefined;
      }
    } catch { if (!this.closed) this.close(1011, "Publication failed"); }
    finally { this.pumping = false; }
  }
}
