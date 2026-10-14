// Contain each collector failure and identify the collecting job on every emitted point.
// Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-027

import { Barry, isBarryError, type Service } from "@barry-rocks/sdk";
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { METRICS, type MetricPoint } from "./schema.js";
import { collectOllama } from "./collect-ollama.js";
import { collectHooks } from "./collect-hooks.js";
import { collectBookkeeping } from "./collect-bookkeeping.js";
import { registry } from "./framework/telemetry.js";
import { barryAppSupportDir, barryCacheDir, barryLogsDir, readServiceRegistry, serviceAddress, ServiceRegistryError, MCP_SERVER_KEY, getServiceUrl, instanceEnvValue } from "@barry-rocks/sdk/services";
import { createLogger as createDiagnosticLogger } from "@barry-rocks/sdk/logging";
const diagnostics = createDiagnosticLogger("telemetry.collect", { transport: "stderr" });

const exec = promisify(execFile);

// Resolve collector tools by absolute path because supervised jobs inherit a minimal PATH.
// Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-028
const BIN = {
  ps: "/bin/ps",
  du: "/usr/bin/du",
  lsof: "/usr/sbin/lsof",
  sysctl: "/usr/sbin/sysctl",
  // /usr/bin, NOT /usr/sbin like sysctl and lsof. Worth stating: launchd's
  // minimal PATH omitting /usr/sbin is what silently blanked the swap and
  // port collectors once, and these absolute paths are the fix for that.
  vmStat: "/usr/bin/vm_stat",
  top: "/usr/bin/top",
} as const;

/** Run a command, returning stdout or null. Never throws. */
async function sh(cmd: string, args: string[], timeoutMs = 5000): Promise<string | null> {
  try {
    const { stdout } = await exec(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch {
    // A non-zero exit is normal here: `lsof` on an unused port. Absence is
    // data, not an error.
    return null;
  }
}

// Discover supervised services so newly installed services need no hardcoded collector entry.
// Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-015
export interface WatchedService {
  /** Registry key, e.g. `sessions.api` or `mcp.server`. */
  key: string;
  /** The full status from MCP. */
  status: Service;
  /** Its assigned port, from the service status. */
  port?: number;
  /** Its readiness path, from the registry entry setup wrote. */
  health?: string;
}

/** Discover services through MCP; callers record a failed collector when it is unavailable. */
export async function discoverServices(list: () => Promise<Service[]> = () => {
  const secret = instanceEnvValue("BARRY_SECRET");
  return Barry.at({ baseUrl: getServiceUrl("api"), secret,
    services: { baseUrl: serviceAddress(MCP_SERVER_KEY), secret } }).services();
}): Promise<WatchedService[]> {
  const status = await list();
  // Health paths are declared in each bag's manifest and published in the
  // registry, so a new bag's service is probed without editing this file.
  let resources: Record<string, { health?: string }> = {};
  try {
    resources = readServiceRegistry().resources;
  } catch (err) {
    if (!(err instanceof ServiceRegistryError)) throw err;
  }
  return status.map((svc) => ({
    key: svc.key,
    status: svc,
    ...(svc.port !== null ? { port: svc.port } : {}),
    ...(resources[svc.key]?.health ? { health: resources[svc.key].health } : {}),
  }));
}

// Supervisor status owns service ports; discovery must not assume default instance ports.
// Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-029
export function portOwnership(svc: WatchedService): 0 | 1 | null {
  const { status } = svc;
  // The supervisor reports a foreign listener as state `conflict`.
  if (status.state === "conflict") return 0;
  // Running with loopbackOnly !== false means the port is ours and safe.
  if (status.state === "running" && status.loopbackOnly !== false) return 1;
  // Starting is too transient to report ownership for.
  if (status.state === "starting") return null;
  // Stopped/backoff with no conflict — the service is down, not squatted.
  return null;
}

/** Parse `lsof -nP -iTCP:<port> -sTCP:LISTEN` into the listening PID. */
export function parseLsofPid(out: string): number | null {
  for (const line of out.trim().split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    const pid = Number(cols[1]);
    if (Number.isFinite(pid) && pid > 0) return pid;
  }
  return null;
}

/** The health probe's own AbortController timeout, and so its honest ceiling. */
const PROBE_TIMEOUT_MS = 4000;

// The elapsed ceiling rejects sleep artifacts while allowing legitimately expensive heavy ticks.
// Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-016
export const SAMPLER_CEILING_MS = 300_000;

// Clamp reported elapsed time without claiming to cancel the underlying operation.
// Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-030
export function elapsedMs(startedAt: number, ceilingMs: number): number {
  const elapsed = performance.now() - startedAt;
  if (!Number.isFinite(elapsed) || elapsed < 0) return 0;
  return Math.min(elapsed, ceilingMs);
}

/** Parse `sysctl vm.swapusage` -> { usedMb, totalMb }. */
export function parseSwapusage(out: string): { usedMb: number; totalMb: number } | null {
  const total = out.match(/total\s*=\s*([\d.]+)M/);
  const used = out.match(/used\s*=\s*([\d.]+)M/);
  if (!total || !used) return null;
  return { totalMb: Number(total[1]), usedMb: Number(used[1]) };
}

/** Parse `sysctl -n kern.num_vnodes kern.maxvnodes` -> { num, max }. */
export function parseVnodes(out: string): { num: number; max: number } | null {
  const lines = out
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;

  const num = Number(lines[0]);
  const max = Number(lines[1]);
  if (!Number.isFinite(num) || !Number.isFinite(max)) return null;
  if (num < 0 || max <= 0) return null;
  // max === 0 is rejected above deliberately: evaluateRule's ratio branch skips
  // a zero denominator silently, so a bad read would present as a healthy one.
  return { num, max };
}

// Keep free, compressed and wired physical pages distinct; process RSS cannot explain kernel pressure.
// Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-031
export function parseVmStat(
  out: string,
): { freePct: number; compressorPct: number; wiredPct: number; wiredMb: number } | null {
  const pages = (label: string): number | null => {
    const m = out.match(new RegExp(`${label}:\\s+(\\d+)`));
    return m ? Number(m[1]) : null;
  };

  const pageSizeMatch = out.match(/page size of (\d+) bytes/);
  if (!pageSizeMatch) return null;
  const pageSize = Number(pageSizeMatch[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;

  const free = pages("Pages free");
  const active = pages("Pages active");
  const inactive = pages("Pages inactive");
  const speculative = pages("Pages speculative") ?? 0;
  const wired = pages("Pages wired down");
  const compressor = pages("Pages occupied by compressor");
  if (free === null || active === null || inactive === null || wired === null || compressor === null) {
    return null;
  }

  // Total is derived from the buckets vm_stat itself reports, so free and
  // compressor share a denominator. hw.memsize would count pages vm_stat does
  // not break out and skew both figures in the same direction.
  const total = free + active + inactive + speculative + wired + compressor;
  if (total === 0) return null;

  return {
    freePct: (free / total) * 100,
    compressorPct: (compressor / total) * 100,
    wiredPct: (wired / total) * 100,
    wiredMb: (wired * pageSize) / 1048576,
  };
}

// Read one process table per tick to avoid hundreds of expensive per-PID calls.
// Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-017
export interface ProcRow {
  pid: number;
  ppid: number;
  rssKb: number;
  // ps CPU percent is a lifetime average; cumulative CPU differences provide interval utilization.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-018
  cpu: number;
  // Cumulative CPU seconds are a counter; derive utilization from successive readings.
  // Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-032
  cpuSec: number;
  etimeSec: number;
  command: string;
}

/** `[[dd-]hh:]mm:ss[.ff]` of cumulative CPU time -> seconds. */
export function parseCpuTime(time: string): number {
  const [days, rest] = time.includes("-") ? time.split("-") : ["0", time];
  const parts = (rest ?? "").split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return seconds + Number(days) * 86400;
}

/** `[[dd-]hh:]mm:ss` -> seconds. */
export function parseEtime(etime: string): number {
  const [days, rest] = etime.includes("-") ? etime.split("-") : ["0", etime];
  const parts = rest.split(":").map(Number);
  const [h, m, s] = parts.length === 3 ? parts : [0, parts[0] ?? 0, parts[1] ?? 0];
  return Number(days) * 86400 + h * 3600 + m * 60 + s;
}

export function parsePs(out: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of out.trim().split("\n").slice(1)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rssKb: Number(m[3]),
      cpu: Number(m[4]),
      cpuSec: parseCpuTime(m[5]),
      etimeSec: parseEtime(m[6]),
      command: m[7] ?? "",
    });
  }
  return rows;
}

// Process grouping must distinguish a session with MCP arguments from an MCP server.
// Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-033
export function classifyProcess(command: string): string | null {
  if (command.includes("hook-dispatch")) return "hook-dispatch";
  if (/\bcaffeinate\b/.test(command)) return "caffeinate";
  // Classify automation browsers by driver cache or headless binary markers; ordinary browsing is excluded.
  // See docs/decisions/0043-telemetry-classification-and-alert-cost.md.
  if (/ms-playwright|puppeteer|chrome-headless|headless_shell|chromedriver/i.test(command)) {
    return "browser-automation";
  }
  // Classify the Claude binary before MCP argument paths, then exempt resident MCP and compile daemons from subprocess-leak candidates.
  // See docs/decisions/0043-telemetry-classification-and-alert-cost.md.
  if (/^(?:\S*\/)?claude\b/.test(command.trim())) return "claude-session";
  // The Barry MCP host itself, matched before the generic /repos/barry node
  // rule below would swallow it as `barry-node`.
  if (/servers\/mcp\/dist\/bundle\.cjs|servers\/mcp\/src\/index\.ts/.test(command)) {
    return "mcp-server";
  }
  if (/mcp-server|\bmcp\b.*server/i.test(command)) return "mcp-server";
  if (/esbuild\b.*--service/.test(command)) return "compile-daemon";
  if (/\bnpx\b|\buvx\b/.test(command)) return "mcp-subprocess";
  if (/tsx|node /.test(command) && command.includes("/repos/barry")) return "barry-node";
  return null;
}

// Do not prune repository-adjacent session worktrees through the instance-directory budget.
// Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-019
export function watchedDirs(): Record<string, string> {
  const support = barryAppSupportDir();
  return {
    data: join(support, "data"),
    archive: join(support, "archive"),
    backups: join(support, "backups"),
    trash: join(support, "trash"),
    logs: barryLogsDir(),
    cache: barryCacheDir(),
  };
}

export interface CollectContext {
  now: number;
  uid: number;
  // Identify the collecting job so equal timestamps from different schedules remain distinct.
  // Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-034
  job: string;
}

// Count descendants under their supervising ancestor to avoid omitting child-process memory.
// Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-035
export function isDescendantOf(pid: number, ancestor: number, procs: ProcRow[]): boolean {
  if (pid === ancestor) return true;
  const parents = new Map(procs.map((p) => [p.pid, p.ppid]));
  let current = pid;
  // Bounded: a pathological cycle in the table must not spin forever.
  for (let depth = 0; depth < 32; depth++) {
    const parent = parents.get(current);
    if (parent === undefined || parent === 0) return false;
    if (parent === ancestor) return true;
    current = parent;
  }
  return false;
}

/** Per-service metrics from the supervisor, resource and health metrics. */
async function collectServices(
  ctx: CollectContext,
  procs: ProcRow[],
  watched: WatchedService[],
): Promise<MetricPoint[]> {
  const points: MetricPoint[] = [];

  await Promise.all(
    watched.map(async (svc) => {
      const { status } = svc;
      // The service label is now its registry key, e.g. `sessions.api`.
      const labels = { service: svc.key };

      const up = (status.state === "running" || status.state === "starting") && status.pid != null;
      points.push({ ts: ctx.now, metric: METRICS.serviceUp.name, value: up ? 1 : 0, labels });

      points.push({ ts: ctx.now, metric: METRICS.serviceRuns.name, value: status.restarts, labels });

      if (status.lastExitCode != null) {
        points.push({ ts: ctx.now, metric: METRICS.serviceLastExit.name, value: status.lastExitCode, labels });
      }

      // Resource usage of the supervised process tree, from the batched ps.
      if (status.pid) {
        // Sum the whole supervised tree. Measuring only the supervised pid
        // would report the wrapper and miss the node process actually doing
        // the work — the one that leaks.
        const tree = procs.filter((p) => isDescendantOf(p.pid, status.pid!, procs));
        if (tree.length > 0) {
          const rssKb = tree.reduce((sum, p) => sum + p.rssKb, 0);
          const cpuSec = tree.reduce((sum, p) => sum + p.cpuSec, 0);
          points.push({ ts: ctx.now, metric: METRICS.serviceRssMb.name, value: rssKb / 1024, labels });
          // Cumulative seconds, NOT ps %CPU. The percentage is derived in the
          // sampler by differencing consecutive samples.
          points.push({ ts: ctx.now, metric: METRICS.serviceCpuSec.name, value: cpuSec, labels });
        }
      }

      // Port ownership: the supervisor reports conflicts directly.
      if (svc.port !== undefined) {
        const lsof = await sh(BIN.lsof, ["-nP", `-iTCP:${svc.port}`, "-sTCP:LISTEN"]);
        const listenPid = lsof ? parseLsofPid(lsof) : null;
        points.push({
          ts: ctx.now,
          metric: METRICS.portListening.name,
          value: listenPid ? 1 : 0,
          labels,
        });
        const owned = portOwnership(svc);
        if (owned !== null) {
          points.push({
            ts: ctx.now,
            metric: METRICS.portOwnedBySupervisor.name,
            value: owned,
            labels,
          });
        }
      }

      if (svc.port !== undefined && svc.health) {
        const started = performance.now();
        const ok = await probeHealth(svc.port, svc.health);
        points.push({ ts: ctx.now, metric: METRICS.healthOk.name, value: ok ? 1 : 0, labels });
        points.push({
          ts: ctx.now,
          metric: METRICS.healthMs.name,
          value: elapsedMs(started, PROBE_TIMEOUT_MS),
          labels,
        });
      }
    }),
  );

  return points;
}

async function probeHealth(port: number, path: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** MCP transport gauge, read from the MCP server's own health endpoint. */
async function collectMcp(ctx: CollectContext): Promise<MetricPoint[]> {
  const points: MetricPoint[] = [];
  let url: string;
  try {
    url = serviceAddress(MCP_SERVER_KEY) + "/health";
  } catch (err) {
    // The registry does not list the engine — no supervisor, or engine not
    // installed. Skip the gauge rather than failing.
    if (err instanceof ServiceRegistryError) return points;
    throw err;
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    const text = await res.text();
    // Tolerates the legacy bare "ok" body: absent JSON simply yields no gauge,
    // rather than a parse error that would take the whole sample down.
    const body: unknown = text.trim().startsWith("{") ? JSON.parse(text) : null;
    if (body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      if (typeof b.transports === "number") {
        points.push({ ts: ctx.now, metric: METRICS.mcpTransports.name, value: b.transports });
      }
      if (typeof b.maxTransports === "number") {
        points.push({ ts: ctx.now, metric: METRICS.mcpTransportsMax.name, value: b.maxTransports });
      }
    }
  } catch {
    // MCP down is already recorded by the per-service health probe.
  }
  return points;
}

/** Child-process counts, footprint and age, grouped by attribution. */
function collectChildren(ctx: CollectContext, procs: ProcRow[]): MetricPoint[] {
  const groups = new Map<string, { count: number; rssKb: number; oldest: number }>();

  for (const p of procs) {
    const kind = classifyProcess(p.command);
    if (!kind) continue;
    const g = groups.get(kind) ?? { count: 0, rssKb: 0, oldest: 0 };
    g.count += 1;
    g.rssKb += p.rssKb;
    g.oldest = Math.max(g.oldest, p.etimeSec);
    groups.set(kind, g);
  }

  const points: MetricPoint[] = [];
  for (const [kind, g] of groups) {
    const labels = { kind };
    points.push({ ts: ctx.now, metric: METRICS.childProcs.name, value: g.count, labels });
    points.push({ ts: ctx.now, metric: METRICS.childRssMb.name, value: g.rssKb / 1024, labels });
    points.push({ ts: ctx.now, metric: METRICS.childOldestSec.name, value: g.oldest, labels });
  }
  return points;
}

/** Host memory and load. */
async function collectHost(ctx: CollectContext): Promise<MetricPoint[]> {
  const points: MetricPoint[] = [];

  const swapOut = await sh(BIN.sysctl, ["vm.swapusage"]);
  const swap = swapOut ? parseSwapusage(swapOut) : null;
  if (swap) {
    points.push({ ts: ctx.now, metric: METRICS.hostSwapUsedMb.name, value: swap.usedMb });
    points.push({ ts: ctx.now, metric: METRICS.hostSwapTotalMb.name, value: swap.totalMb });
  }

  // Memory pressure proper. Swap says what has ALREADY been paged out; the
  // compressor rises first, so this is the signal that arrives in time to act
  // on. hostMemFreePct was declared in the schema from the beginning and never
  // collected until now.
  const vmOut = await sh(BIN.vmStat, []);
  const vm = vmOut ? parseVmStat(vmOut) : null;
  if (vm) {
    points.push({ ts: ctx.now, metric: METRICS.hostMemFreePct.name, value: vm.freePct });
    points.push({ ts: ctx.now, metric: METRICS.hostMemCompressorPct.name, value: vm.compressorPct });
    // Wired was computed by parseVmStat from the start and used only as a
    // denominator term. Recording it is what makes the "RSS says 5.95GB, the
    // host says 15GB" gap explainable rather than merely visible.
    points.push({ ts: ctx.now, metric: METRICS.hostMemWiredPct.name, value: vm.wiredPct });
    points.push({ ts: ctx.now, metric: METRICS.hostMemWiredMb.name, value: vm.wiredMb });
  }

  // The vnode cache: a large, unpageable contributor to wired memory that no
  // per-process measurement can see. Both halves are recorded so the rule can
  // be a ratio and survive someone retuning kern.maxvnodes.
  const vnodeOut = await sh(BIN.sysctl, ["-n", "kern.num_vnodes", "kern.maxvnodes"]);
  const vnodes = vnodeOut ? parseVnodes(vnodeOut) : null;
  if (vnodes) {
    points.push({ ts: ctx.now, metric: METRICS.hostVnodes.name, value: vnodes.num });
    points.push({ ts: ctx.now, metric: METRICS.hostVnodesMax.name, value: vnodes.max });
  }

  const loadOut = await sh(BIN.sysctl, ["-n", "vm.loadavg"]);
  const load1 = loadOut?.match(/\{\s*([\d.]+)/);
  if (load1) points.push({ ts: ctx.now, metric: METRICS.hostLoad1.name, value: Number(load1[1]) });

  return points;
}

// Use footprint values from top rather than summing overlapping process RSS.
// Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-036
export function parseTopMem(out: string): Map<number, number> | null {
  const byPid = new Map<number, number>();
  let inRows = false;

  for (const line of out.split("\n")) {
    if (!inRows) {
      // The header row begins the table; everything above it is the summary.
      if (/^\s*PID\s/.test(line)) inRows = true;
      continue;
    }

    // pid, magnitude, unit, and the +/- delta marker top emits when sampling
    // more than once (`4356M+`). Tolerated here so a caller adding -l 2 does
    // not silently make every row unparseable.
    const m = line.match(/^\s*(\d+)\s+([\d.]+)([KMGB])[+-]?\s/);
    if (!m) continue;

    const pid = Number(m[1]);
    const magnitude = Number(m[2]);
    if (!Number.isFinite(pid) || !Number.isFinite(magnitude)) continue;

    // An unrecognised suffix is rejected rather than coerced: reading "4439X"
    // as 4439 MB would be a plausible-looking number with no basis.
    let mb: number;
    switch (m[3]) {
      case "B": mb = magnitude / 1048576; break;
      case "K": mb = magnitude / 1024; break;
      case "M": mb = magnitude; break;
      case "G": mb = magnitude * 1024; break;
      default: continue;
    }
    byPid.set(pid, mb);
  }

  return byPid.size > 0 ? byPid : null;
}

/** How many processes get their own `procFootprintMb` series. */
const FOOTPRINT_TOP_N = 12;

// Keep host memory and service footprints separate; shared pages make summed RSS misleading.
// Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-037
async function collectFootprint(
  ctx: CollectContext,
  procs: ProcRow[],
  watched: WatchedService[],
): Promise<MetricPoint[]> {
  const points: MetricPoint[] = [];

  // -n 500, not -n 0: `top`'s -n is "show this many processes", and 0 means
  // literally none — it prints the summary block and no table at all. That is a
  // silent failure shaped exactly like a healthy run, and it is what the
  // collectorOk point below exists to catch. 500 against ~680 processes is
  // ample because rows arrive sorted by memory descending, so anything large
  // enough to matter is in the first few dozen.
  const out = await sh(BIN.top, ["-l", "1", "-n", "500", "-o", "mem", "-stats", "pid,mem,command"], 10_000);
  const byPid = out ? parseTopMem(out) : null;

  // A broken collector must be visible as a metric, not as absent data. This
  // reuses the existing collector-broken rule with no new rule code, and is the
  // difference between "top is failing" and "the machine looks fine".
  points.push({
    ts: ctx.now,
    metric: METRICS.collectorOk.name,
    value: byPid ? 1 : 0,
    labels: { tool: "top-parse" },
  });
  if (!byPid) return points;

  // Per-service: sum the supervised tree, exactly as collectServices does for
  // RSS, so the two are directly comparable.
  for (const svc of watched) {
    const pid = svc.status.pid;
    if (!pid) continue;

    const tree = procs.filter((p) => isDescendantOf(p.pid, pid, procs));
    const matched = tree.filter((p) => byPid.has(p.pid));
    // No point rather than a zero when top did not report this service's
    // pids. ps and top run at different instants, so a process may legitimately
    // appear in one and not the other — and a 0 would read as "uses no memory".
    if (matched.length === 0) continue;

    const mb = matched.reduce((sum, p) => sum + (byPid.get(p.pid) ?? 0), 0);
    points.push({
      ts: ctx.now,
      metric: METRICS.serviceFootprintMb.name,
      value: mb,
      labels: { service: svc.key },
    });
  }

  // Whole-host top-N, Barry's or not. The consumers that actually broke this
  // machine were a virtualization helper VM and an ollama runner: a metric scoped to Barry
  // would have reported a healthy box throughout.
  const nameFor = (pid: number): string => {
    const proc = procs.find((p) => p.pid === pid);
    if (!proc) return `pid:${pid}`;
    const bin = proc.command.trim().split(/\s+/)[0] ?? "";
    return bin.split("/").pop() || `pid:${pid}`;
  };

  const ranked = [...byPid.entries()].sort((a, b) => b[1] - a[1]).slice(0, FOOTPRINT_TOP_N);
  ranked.forEach(([pid, mb], i) => {
    points.push({
      ts: ctx.now,
      metric: METRICS.procFootprintMb.name,
      value: mb,
      labels: { name: nameFor(pid), rank: String(i + 1) },
    });
  });

  let total = 0;
  for (const mb of byPid.values()) total += mb;
  points.push({ ts: ctx.now, metric: METRICS.procFootprintTotalMb.name, value: total });

  return points;
}

// Measure only watched directories and isolate du failures from other collectors.
// Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-038
async function collectDisk(ctx: CollectContext): Promise<MetricPoint[]> {
  const points: MetricPoint[] = [];
  await Promise.all(
    Object.entries(watchedDirs()).map(async ([dir, path]) => {
      const out = await sh(BIN.du, ["-sk", path], 120_000);
      const kb = Number(out?.trim().split(/\s+/)[0]);
      if (Number.isFinite(kb)) {
        points.push({ ts: ctx.now, metric: METRICS.diskDirMb.name, value: kb / 1024, labels: { dir } });
      }
    }),
  );
  return points;
}

// Check required binaries explicitly so missing tools produce visible collector failures.
// Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-020
function collectSelfCheck(ctx: CollectContext): MetricPoint[] {
  return Object.entries(BIN).map(([name, path]) => {
    let ok = false;
    try {
      accessSync(path, constants.X_OK);
      ok = true;
    } catch {
      ok = false;
    }
    return { ts: ctx.now, metric: METRICS.collectorOk.name, value: ok ? 1 : 0, labels: { tool: name } };
  });
}

export interface SampleOptions {
  // Run directory walks on the slower heavy schedule because they dominate collector cost.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-021
  heavy?: boolean;
  // Footprint sampling has its own cadence between the minute tick and hourly sweep.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-022
  footprint?: boolean;
  now?: number;
  services?: () => Promise<Service[]>;
}

/** Take one full sample. Individual collector failures are contained. */
export async function sample(opts: SampleOptions = {}): Promise<MetricPoint[]> {
  const started = performance.now();
  // Same derivation `mode` uses below, computed up front so collectors can
  // attribute their points to the job that ran them.
  const job = opts.heavy ? "sweep" : opts.footprint ? "footprint" : "sample";
  const ctx: CollectContext = {
    now: opts.now ?? Math.floor(Date.now() / 1000),
    uid: process.getuid?.() ?? 501,
    job,
  };

  // One ps for the whole tree, shared by the service and children collectors.
  const psOut = await sh(BIN.ps, ["-Ao", "pid,ppid,rss,%cpu,time,etime,command"], 15_000);
  const procs = psOut ? parsePs(psOut) : [];
  let watched: WatchedService[] = [], servicesOk = true;
  try { watched = await discoverServices(opts.services); }
  catch (error) {
    if (!isBarryError(error) && !(error instanceof ServiceRegistryError)) throw error;
    servicesOk = false;
  }

  const groups = await Promise.allSettled([
    collectServices(ctx, procs, watched),
    collectMcp(ctx),
    Promise.resolve(collectChildren(ctx, procs)),
    collectHost(ctx),
    Promise.resolve(collectSelfCheck(ctx)),
    opts.heavy ? collectDisk(ctx) : Promise.resolve([]),
    opts.footprint ? collectFootprint(ctx, procs, watched) : Promise.resolve([]),
    // Ollama, on the footprint tick rather than the 60s one: it answers the
    // same question as collectFootprint (what is holding memory) and two HTTP
    // calls per 5 minutes is a duty cycle worth not paying every minute.
    // Also returns a collectorOk point on every path — a quit Ollama and an
    // idle one both load no models, so that point is the only thing that tells
    // them apart.
    opts.footprint ? collectOllama(ctx.now) : Promise.resolve([]),
    // The other half of the Ollama picture, read from the job's own summary
    // line in jobs.db: how long inference took and whether the job kept up.
    // Same tick as the collector above, since the two are read together.
    opts.footprint ? Promise.resolve(collectBookkeeping(ctx.now)) : Promise.resolve([]),
    // Record-hook activity, scraped from the API that runs the hooks. On the
    // BASE tick, not the footprint one: `hook-dispatch-silent` measures how
    // long the seam has been quiet, and sampling it five times less often would
    // put that much slack into the answer. One loopback GET is cheap enough.
    //
    // The gate is what makes that comment true. This call was unconditional, so
    // it also ran under `footprint` and `sweep` -- whose manifests do not
    // declare BARRY_SECRET, because the base tick is the only job that needs
    // it. Every one of those ticks reported `collectorOk{tool:"hooks"} = 0`
    // from the no-secret path, which is how a healthy seam charted as 10-of-10
    // failures on footprint and 3-of-3 on sweep while `sample` scraped it
    // successfully all along. The secret does not belong in those manifests:
    // the collector does not belong on those ticks.
    !opts.heavy && !opts.footprint ? collectHooks(ctx.now) : Promise.resolve([]),
  ]);

  const points: MetricPoint[] = [{ ts: ctx.now, metric: METRICS.collectorOk.name, value: servicesOk ? 1 : 0, labels: { tool: "services" } }];
  for (const g of groups) {
    // A rejected collector costs its own metrics and nothing else.
    if (g.status === "fulfilled") points.push(...g.value);
  }

  // Contributed collectors, under the same isolation as the built-in ones.
  //
  // `collectAll` runs them under its own `Promise.allSettled`, so a contributed
  // collector that throws costs its own metrics and nothing else -- the same
  // guarantee the literal above has always had. Appended HERE, before the
  // provenance loop, so contributed points get the `job` label for free and are
  // counted by `samplerPoints` below: a contributor whose points were invisible
  // to the point count would make the tick look cheaper than it is.
  //
  // With nothing registered this is an empty settle of an empty array: no
  // points, no failures, and `collectorOk` untouched. That is the zero-
  // contributor case, and it must stay byte-identical to the hardcoded list.
  const contributed = await registry.collectAll();
  points.push(...contributed.points);

  // A failing contributor is NAMED, never swallowed. An unattributable bad
  // collector is exactly how the leaked MCP transport stayed anonymous, and a
  // failure that only ever appeared in stderr would be invisible to the very
  // dashboard this bag exists to populate -- so it is BOTH logged and recorded
  // as a `collectorOk` zero, which `collector-broken` already alerts on.
  for (const bag of contributed.failed) {
    diagnostics.error("telemetry.collector_failed", { detail: `[metrics] contributed collector from "${bag}" failed` });
    points.push({
      ts: ctx.now,
      metric: METRICS.collectorOk.name,
      value: 0,
      labels: { tool: `bag:${bag}` },
    });
  }

  // Labelled by mode: the heavy tick walks ~/.barry with du and legitimately
  // takes tens of seconds, while the light tick is sub-second. Sharing one
  // series would either alarm on every sweep or set the threshold so high it
  // could never catch a light tick going bad.
  const mode = opts.heavy ? "heavy" : opts.footprint ? "footprint" : "light";

  // Stamp provenance on every point, at the one boundary they all pass through.
  //
  // Done here rather than in each of ~52 collectors for two reasons: it cannot
  // be forgotten by a collector added later, and a contributed collector gets
  // it for free without knowing the rule exists.
  //
  // `job` rather than `mode` as the label name: `mode` already means something
  // narrower on samplerMs below ("heavy" vs "light" WORK), while this answers
  // "which scheduled job produced this row". Reusing the name would conflate a
  // cost signal with an identity one.
  //
  // A point that already carries `job` keeps it -- nothing sets it today, but a
  // future collector that genuinely knows better should not be overwritten.
  for (const p of points) {
    p.labels = p.labels?.job ? p.labels : { ...(p.labels ?? {}), job: ctx.job };
  }

  // Pushed AFTER the provenance loop, so these two carry `mode` and not `job`.
  // That is deliberate: `mode` distinguishes heavy from light WORK, which is
  // the question "did the sampler get expensive" needs, and `sampler-expensive`
  // scopes itself with `labelIn: { mode: ["light"] }`. Adding `job` would
  // re-key those series and break that filter for no gain -- these are written
  // once per tick by definition, so they never collide with themselves.
  points.push({
    ts: ctx.now,
    metric: METRICS.samplerMs.name,
    value: elapsedMs(started, SAMPLER_CEILING_MS),
    labels: { mode },
  });
  points.push({ ts: ctx.now, metric: METRICS.samplerPoints.name, value: points.length, labels: { mode } });
  return points;
}
