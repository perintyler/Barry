/** FIFO durability independent of delivery. Limits govern admission, never drops. */
export class PersistenceBacklogError extends Error {
  readonly code = "persistence_lagging";
  readonly retryable = true;
}
interface Entry<T> { value: T; bytes: number; at: number; write: () => Promise<unknown> }
export class PersistQueue<T> {
  static bytes = 0;
  private static active=new Set<PersistQueue<unknown>>();
  static async drainAll(timeoutMs=30_000):Promise<boolean> {return (await Promise.all([...this.active].map(q=>q.flush(timeoutMs)))).every(Boolean);}
  private entries: Entry<T>[] = [];
  private running = false;
  private lagging = false;
  private invariantFailed = false;
  private lagTimer?: ReturnType<typeof setTimeout>;
  private waiters = new Set<() => void>();
  bytes = 0;
  constructor(private readonly notify: (lagging: boolean, error?: unknown) => void,
    private readonly limit = 4 * 1024 * 1024, private readonly globalLimit = 64 * 1024 * 1024) {}
  static assertGlobalAdmission():void {if(this.bytes>=64*1024*1024)throw new PersistenceBacklogError("Recording delayed; retry after the transcript catches up");}
  assertAdmission(): void {
    if (this.invariantFailed || this.bytes >= this.limit || PersistQueue.bytes >= this.globalLimit) {
      throw new PersistenceBacklogError("Recording delayed; retry this turn after the transcript catches up");
    }
  }
  pending(): T[] { return this.entries.map(e => e.value); }
  enqueue(value: T, bytes: number, write: () => Promise<unknown>): void {
    PersistQueue.active.add(this as PersistQueue<unknown>);
    this.entries.push({ value, bytes, at: Date.now(), write });
    this.bytes += bytes; PersistQueue.bytes += bytes;
    if (!this.lagTimer) { this.lagTimer = setTimeout(() => { this.lagTimer=undefined; if (this.entries.length) this.warn(); }, 1000); this.lagTimer.unref(); }
    if (this.bytes >= this.limit || PersistQueue.bytes >= this.globalLimit) this.warn();
    // Start on the next task: sending this frame must precede starting SQLite.
    if (!this.running) { this.running=true; setImmediate(() => void this.work()); }
  }
  private warn(error?: unknown): void { if (!this.lagging || error) {this.lagging=true; this.notify(true,error);} }
  private async work(): Promise<void> {
    let backoff=100;
    while (this.entries.length) {
      const entry=this.entries[0]!;
      try { await entry.write(); }
      catch (error) {
        if (/SQLITE_CONSTRAINT_UNIQUE|UNIQUE constraint failed/i.test(String(error))) this.invariantFailed=true;
        this.warn(error);
        await new Promise<void>(resolve=>setTimeout(resolve,backoff));
        backoff=Math.min(5000,backoff*2); continue;
      }
      this.entries.shift(); this.bytes-=entry.bytes; PersistQueue.bytes-=entry.bytes; backoff=100;
    }
    this.running=false; this.invariantFailed=false; PersistQueue.active.delete(this as PersistQueue<unknown>);
    if (this.lagTimer) clearTimeout(this.lagTimer); this.lagTimer=undefined;
    if (this.lagging) {this.lagging=false; this.notify(false);}
    for (const done of this.waiters) done(); this.waiters.clear();
  }
  async flush(timeoutMs=1000): Promise<boolean> {
    if (!this.entries.length) return true;
    return new Promise(resolve=>{
      const done=()=>{clearTimeout(timeout);this.waiters.delete(done);resolve(true);};
      const timeout=setTimeout(()=>{this.waiters.delete(done);resolve(false);},timeoutMs);
      this.waiters.add(done);
    });
  }
}
