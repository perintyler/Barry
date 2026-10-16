/** Runs only inside a live detached guardian. Never accepts a recovered PID. */
import { spawnSync } from "node:child_process";

const GUARDIAN_LINEAGE_ENV = "BARRY_PROCESS_GUARDIAN";
export interface EscapedDescendantIdentity { pid: number; start: string }
type ProcessSnapshotEntry = { pid: number; ppid: number; pgid: number; state: string; start: string; command: string };
const psLine = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})(?:\s+(.*))?$/;

function observeProcessTable(): ProcessSnapshotEntry[] | undefined {
  const args = process.platform === "darwin"
    ? ["-xE", "-o", "pid=,ppid=,pgid=,state=,lstart=,command="]
    : ["axeo", "pid=,ppid=,pgid=,state=,lstart=,command="];
  const result = spawnSync("/bin/ps", args, {
    encoding: "utf8", timeout: 1500, maxBuffer: 16 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
  });
  if (result.error || result.status !== 0) return undefined;
  const entries: ProcessSnapshotEntry[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    const match = psLine.exec(line);
    if (!match) return undefined;
    const pid = Number(match[1]);
    if (pid === result.pid) continue;
    entries.push({ pid, ppid: Number(match[2]), pgid: Number(match[3]), state: match[4], start: match[5], command: match[6] ?? "" });
  }
  return entries;
}

/** Verifies that neither the guardian group nor any lineage-bearing or escaped descendant remains live. */
export function guardianDescendantsAbsent(guardianPid: number, guardianStartedAt?: number, escaped: readonly EscapedDescendantIdentity[] = []): boolean {
  if (!Number.isInteger(guardianPid) || guardianPid <= 0) return true;
  try { process.kill(-guardianPid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; }
  const entries = observeProcessTable();
  if (!entries) return false;
  const tokenPattern = new RegExp(`(?:^|\\s)${GUARDIAN_LINEAGE_ENV}=v1:${guardianPid}:${guardianStartedAt !== undefined ? String(guardianStartedAt) : "\\d+"}(?:\\s|$)`);
  for (const entry of entries) {
    if (entry.pid === guardianPid || entry.pgid === guardianPid) return false;
    if (!entry.state.startsWith("Z") && tokenPattern.test(entry.command)) return false;
  }
  for (const item of escaped) {
    if (entries.some(entry => entry.pid === item.pid && entry.start === item.start && !entry.state.startsWith("Z"))) return false;
  }
  return true;
}

export class ProcessGroupGuardian {
  private stopping = false;
  private running = false;
  private exitCode = 1;
  private escalation?: ReturnType<typeof setTimeout>;
  private poll?: ReturnType<typeof setInterval>;
  private deadlineTimer?: ReturnType<typeof setTimeout>;
  private deadline: number;
  private readonly lineageToken: string;
  private readonly escaped = new Map<string, EscapedDescendantIdentity>();

  constructor(private readonly options: { deadline: number; stopping(): void; timedOut?(): void; escaped?(descendants: EscapedDescendantIdentity[]): void }) {
    if (process.platform === "win32" || !Number.isFinite(options.deadline) || options.deadline <= 0) throw new Error("Guardian deadline is unavailable");
    this.deadline = options.deadline;
    const self = spawnSync("/bin/ps", ["-o", "pgid=,lstart=", "-p", String(process.pid)], {
      encoding: "utf8", timeout: 1000, env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
    });
    const selfMatch = self.status === 0 && !self.error
      ? /^\s*(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/.exec(self.stdout.trim())
      : null;
    const startedMs = selfMatch ? Date.parse(`${selfMatch[2]} UTC`) : Number.NaN;
    if (!selfMatch || Number(selfMatch[1]) !== process.pid || !Number.isFinite(startedMs)) throw new Error("Guardian must own its detached process group");
    this.lineageToken = `v1:${process.pid}:${Math.floor(startedMs / 1000)}`;
    process.env[GUARDIAN_LINEAGE_ENV] = this.lineageToken;
    process.on("SIGTERM", () => this.stop());
    this.armDeadline();
  }

  environment(env: NodeJS.ProcessEnv): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) if (typeof value === "string") out[key] = value;
    out[GUARDIAN_LINEAGE_ENV] = this.lineageToken;
    return out;
  }

  private armDeadline(): void {
    clearTimeout(this.deadlineTimer);
    if (this.stopping) return;
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) {
      try { this.options.timedOut?.(); } catch { /* Reporting loss cannot remove native ownership. */ }
      this.stop();
    }
    else this.deadlineTimer = setTimeout(() => this.armDeadline(), Math.min(remaining, 2_147_483_647));
  }

  /** A command's shorter budget may narrow, never reset, its accepted deadline. */
  narrowDeadline(deadline: number): void {
    if (!Number.isFinite(deadline) || deadline <= 0) throw new Error("Guardian deadline is unavailable");
    this.deadline = Math.min(this.deadline, deadline);this.armDeadline();
  }

  /** A bounded native observation; unknown membership never permits early exit. */
  private members(): number[] | undefined {
    const entries = observeProcessTable();
    if (!entries) return undefined;
    const members: number[] = [];
    const groupPids = new Set<number>([process.pid]);
    const tokenPattern = new RegExp(`(?:^|\\s)${GUARDIAN_LINEAGE_ENV}=${this.lineageToken}(?:\\s|$)`);
    for (const entry of entries) {
      if (entry.pgid === process.pid) {
        members.push(entry.pid);
        groupPids.add(entry.pid);
      }
    }
    const escapedPids = new Set<number>();
    for (const entry of entries) {
      if (entry.pgid !== process.pid && !entry.state.startsWith("Z") && (tokenPattern.test(entry.command) || groupPids.has(entry.ppid))) {
        escapedPids.add(entry.pid);
      }
    }
    let added = true;
    while (added) {
      added = false;
      for (const entry of entries) {
        if (entry.pgid !== process.pid && !entry.state.startsWith("Z") && !escapedPids.has(entry.pid) && escapedPids.has(entry.ppid)) {
          escapedPids.add(entry.pid);
          added = true;
        }
      }
    }
    const liveKeys = new Set<string>();
    for (const entry of entries) {
      if (escapedPids.has(entry.pid) || (this.escaped.has(`${entry.pid}:${entry.start}`) && !entry.state.startsWith("Z"))) {
        const key = `${entry.pid}:${entry.start}`;
        liveKeys.add(key);
        this.escaped.set(key, { pid: entry.pid, start: entry.start });
      }
    }
    for (const key of this.escaped.keys()) if (!liveKeys.has(key)) this.escaped.delete(key);
    return members;
  }

  beforeLaunch(): void {
    this.assertActive();
    this.running = true;
  }

  assertActive(): void {
    if (this.stopping || Date.now() >= this.deadline) throw new Error("Guardian launch is fenced");
  }

  private reportEscaped(): void {
    if (this.escaped.size === 0) return;
    try { this.options.escaped?.([...this.escaped.values()]); } catch { /* Reporting loss cannot abandon native ownership. */ }
  }

  applicationClosed(code: number | null, report: () => void = () => {}): void {
    this.running = false;
    this.exitCode = code === 0 ? 0 : 1;
    const members = this.members();
    const safeReport = () => { this.reportEscaped(); try { report(); } catch { /* Reporting loss cannot abandon native ownership. */ } };
    if (members && members.every(pid => pid === process.pid)) { safeReport();process.exit(this.exitCode); }
    // A root exit cannot abandon detached-stdio descendants. Keep the group ID
    // alive until every member has ceased or this guardian kills its own group.
    this.stop();
    safeReport();
  }

  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    clearTimeout(this.deadlineTimer);
    this.escalation = setTimeout(() => {
      // This process is still the live group leader, so the group cannot have
      // been recycled. No caller may use this operation after guardian death.
      process.kill(-process.pid, "SIGKILL");
    }, 5000);
    try { this.options.stopping(); } catch { /* Parent loss does not remove ownership. */ }
    process.kill(-process.pid, "SIGTERM");
    this.poll = setInterval(() => {
      const members = this.members();
      if (!this.running && members && members.every(pid => pid === process.pid)) {
        this.reportEscaped();
        clearTimeout(this.escalation);clearInterval(this.poll);process.exit(this.exitCode);
      }
    }, 50);
  }
}
