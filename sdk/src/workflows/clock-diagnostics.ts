/** Wall time is durable deadline authority; monotonic time detects local jumps. */
export class ClockDiagnostics {
  private previous?: { wall: number; monotonic: number };
  private jumps = 0;
  private lastJumpAt: number | null = null;
  private lastDriftMs = 0;
  private maximumDriftMs = 0;
  sample(wall = Date.now(), monotonic = performance.now()): void {
    if (this.previous) {
      const drift = wall - this.previous.wall - (monotonic - this.previous.monotonic);
      if (Math.abs(drift) >= 1000) {
        this.jumps++; this.lastJumpAt = wall; this.lastDriftMs = drift;
        this.maximumDriftMs = Math.max(this.maximumDriftMs, Math.abs(drift));
      }
    }
    this.previous = { wall, monotonic };
  }
  status() { return { jumps: this.jumps, lastJumpAt: this.lastJumpAt, lastDriftMs: this.lastDriftMs, maximumDriftMs: this.maximumDriftMs, deadlineClock: "wall", watchdogClock: "monotonic" }; }
}
