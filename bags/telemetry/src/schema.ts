// Keep metric names, units and label contracts shared by collectors and consumers.
// Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-110

/** Every metric this bag collects, with the unit it is recorded in. */
export const METRICS = {
  /**
   * launchd's cumulative run count for a job. Monotonic per launchd load, so
   * the SIGNAL IS THE DELTA, not the value: a service that restarts twice in
   * an hour is crash-looping even though a bare liveness probe finds it up
   * both times. This is the metric that would have named the EADDRINUSE loop.
   */
  // Cumulative warn/error counts distinguish ingestion progress from an empty interval.
  // Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-111
  errorEvents: {
    name: "barry.errors.count",
    unit: "count",
    description:
      "Cumulative warn/error log events per service. The signal is the DELTA — a spike is a slope, and a threshold on the raw count would fire forever once crossed.",
  },
  serviceRuns: {
    name: "barry.service.runs",
    unit: "count",
    description:
      "launchd's cumulative run count for a job. The signal is the DELTA, not the value — a crash loop is invisible to a bare liveness probe, which finds the service up on both sides of a restart.",
  },
  /** 1 when launchd reports a live PID for the label, else 0. */
  serviceUp: {
    name: "barry.service.up",
    unit: "bool",
    description:
      "1 when launchd reports a live PID for the label, else 0.",
  },
  /** launchd's last exit status. Lies about the CURRENT instance — see doc in collect.ts. */
  serviceLastExit: {
    name: "barry.service.last_exit",
    unit: "code",
    description:
      "launchd's last exit status. Lies about the CURRENT instance — it reports the last exit of a previous one.",
  },
  /** Resident set size of the supervised process. Under memory pressure this UNDERSTATES badly. */
  serviceRssMb: {
    name: "barry.service.rss_mb",
    unit: "MB",
    description:
      "Resident set size of the supervised process. Under memory pressure this UNDERSTATES badly, because pages are swapped out.",
  },
  /** Real memory footprint, which unlike RSS does not collapse when a process is paged out. */
  serviceFootprintMb: {
    name: "barry.service.footprint_mb",
    unit: "MB",
    description:
      "Real memory footprint, which unlike RSS does not collapse when a process is paged out.",
  },
  // CPU seconds are cumulative across the supervised process tree.
  // Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-112
  serviceCpuSec: {
    name: "barry.service.cpu_sec",
    unit: "s",
    description:
      "Cumulative CPU seconds since exec, summed over the supervised tree. Differenced between samples to give real interval CPU — ps %CPU is a lifetime average and cannot detect a wedge.",
  },
  // Derive interval utilization from cumulative CPU readings; do not chart the raw counter as percent.
  // Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-113
  serviceCpuPct: {
    name: "barry.service.cpu_pct",
    unit: "%",
    description:
      "Interval CPU percent, derived by differencing cumulative CPU seconds between samples. Can exceed 100 on a multi-core host — 200 means two cores saturated.",
  },

  /** 1 when the health endpoint returned 2xx within the timeout, else 0. */
  healthOk: {
    name: "barry.health.ok",
    unit: "bool",
    description:
      "1 when the health endpoint returned 2xx within the timeout, else 0.",
  },
  /**
   * Health-probe latency. Liveness alone passes a server whose event loop is
   * spun: it still accepts the connection. The latency is what gives it away.
   */
  healthMs: {
    name: "barry.health.ms",
    unit: "ms",
    description:
      "Health-probe latency. Liveness alone passes a server whose event loop is spun — it still accepts the connection. The latency is what gives it away.",
  },

  /**
   * 1 when the PID listening on a service's port is the PID launchd supervises.
   * 0 means an orphan is squatting — the state that made every API restart die
   * EADDRINUSE while launchd kept reporting success.
   */
  portOwnedBySupervisor: {
    name: "barry.port.owned_by_supervisor",
    unit: "bool",
    description:
      "1 when the PID listening on a service's port is the PID launchd supervises. 0 means an orphan is squatting.",
  },
  /** 1 when anything at all is listening on the port. */
  portListening: {
    name: "barry.port.listening",
    unit: "bool",
    description:
      "1 when anything at all is listening on the port.",
  },

  /** Live MCP transports. The leak that reached 1,628 against a ceiling of 400. */
  mcpTransports: {
    name: "barry.mcp.transports",
    unit: "count",
    description:
      "Live MCP transports. The leak that reached 1,628 against a ceiling of 400.",
  },
  /** The ceiling, recorded alongside so a rule can alert on the RATIO and survive a retune. */
  mcpTransportsMax: {
    name: "barry.mcp.transports_max",
    unit: "count",
    description:
      "The transport ceiling, recorded alongside so a rule can alert on the RATIO and survive a retune.",
  },

  /** Count of Barry-spawned children, by kind. Attributed by parent so a normal caffeinate fleet is not a leak. */
  childProcs: {
    name: "barry.children.count",
    unit: "count",
    description:
      "Count of Barry-spawned children, by kind. Attributed by parent so a normal caffeinate fleet is not read as a leak.",
  },
  /** Aggregate RSS of those children. One chrome-devtools-mcp once reached 4.3GB alone. */
  childRssMb: {
    name: "barry.children.rss_mb",
    unit: "MB",
    description:
      "Aggregate RSS of Barry-spawned children. One chrome-devtools-mcp once reached 4.3GB alone.",
  },
  /** Age of the oldest child. A headless browser idle for hours is the leak's tell. */
  childOldestSec: {
    name: "barry.children.oldest_sec",
    unit: "s",
    description:
      "Age of the oldest child process. A headless browser idle for hours is the leak's tell.",
  },

  /** Size of a tracked directory of the instance, labelled by what it holds. */
  diskDirMb: {
    name: "barry.disk.dir_mb",
    unit: "MB",
    description:
      "Size of a tracked directory of the instance (data, logs, cache, trash, ...), labelled by what it holds.",
  },

  /**
   * Swap in use. Host-level on purpose: under pressure per-process RSS reads
   * near zero because processes are paged OUT, so summing RSS to find "who is
   * using memory" points at nothing. Swap is the honest signal.
   */
  hostSwapUsedMb: {
    name: "barry.host.swap_used_mb",
    unit: "MB",
    description:
      "Swap in use. Host-level on purpose: under pressure per-process RSS reads near zero because processes are paged OUT, so swap is the honest signal.",
  },
  hostSwapTotalMb: {
    name: "barry.host.swap_total_mb",
    unit: "MB",
    description:
      "Total swap configured on the host, the denominator for swap-used.",
  },
  // Free physical pages differ from process RSS and cached memory.
  // Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-114
  hostMemFreePct: {
    name: "barry.host.mem_free_pct",
    unit: "%",
    description:
      "Free physical memory as a share of all pages, from vm_stat. Low on its own is NOT alarming on macOS — the compressor and swap metrics say whether the host is actually under pressure.",
  },
  // Compressor share measures host pressure independently of any single process footprint.
  // Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-115
  hostMemCompressorPct: {
    name: "barry.host.mem_compressor_pct",
    unit: "%",
    description:
      "Share of physical memory held by the compressor. The EARLY signal that swap is not: macOS compresses before it swaps, so this rises first.",
  },
  // Wired kernel memory cannot be paged or compressed; process-only rankings cannot account for it.
  // Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-116
  hostMemWiredPct: {
    name: "barry.host.mem_wired_pct",
    unit: "%",
    description:
      "Share of physical memory that is WIRED — kernel memory that can never be paged out or compressed. It is the floor under every other memory number.",
  },
  /** Wired memory in MB. The percentage is what a rule reads; this is what a human acts on. */
  hostMemWiredMb: {
    name: "barry.host.mem_wired_mb",
    unit: "MB",
    description:
      "Wired memory in MB. The percentage is the rule-able signal; the absolute figure is what a human needs in order to act.",
  },
  // Vnode counts describe kernel allocation; their allocation ratio alone is not pressure evidence.
  // Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-117
  hostVnodes: {
    name: "barry.host.vnodes",
    unit: "count",
    description:
      "Vnodes in use — the kernel's cache of open filesystem objects, and a large contributor to wired memory.",
  },
  /** The vnode ceiling, recorded alongside so a rule alerts on the RATIO and survives a retune. */
  hostVnodesMax: {
    name: "barry.host.vnodes_max",
    unit: "count",
    description:
      "The vnode ceiling (kern.maxvnodes), recorded alongside so a rule can alert on the RATIO and survive a retune.",
  },
  /** 1-minute load average. */
  hostLoad1: {
    name: "barry.host.load1",
    unit: "load",
    description:
      "1-minute load average.",
  },

  // Footprint rankings include non-Barry processes so external consumers of host memory remain visible.
  // Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-118
  procFootprintMb: {
    name: "barry.proc.footprint_mb",
    unit: "MB",
    description:
      "Real memory footprint of the heaviest processes on the host, Barry's or not, labelled {name, rank}. Bounded to the top 12 — RSS understated the largest consumer by 21x.",
  },
  /**
   * Total footprint across every process `top` reported.
   *
   * The number that makes the RSS gap legible at a glance: summed RSS said
   * 5.95GB while the host had 15GB in use.
   */
  procFootprintTotalMb: {
    name: "barry.proc.footprint_total_mb",
    unit: "MB",
    description:
      "Total real footprint across all processes. Makes the RSS gap legible: summed RSS read 5.95GB while 15GB was in use.",
  },

  /**
   * How long a sample took. Recorded because a monitor that becomes expensive
   * is the failure it exists to catch: this bag polls a box that has been at
   * 91% swap, and its cost must be visible in its own output.
   */
  samplerMs: {
    name: "barry.sampler.ms",
    unit: "ms",
    description:
      "How long COLLECTION took — the collectors only, not the tick around them. Compare against barry.sampler.tick_ms, which is what the job actually costs.",
  },
  // The whole-tick duration includes rule evaluation, notification and maintenance.
  // Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-119
  samplerTickMs: {
    name: "barry.sampler.tick_ms",
    unit: "ms",
    description:
      "How long the whole tick took — collect, write, evaluate, notify, maintain. The honest cost of the job; barry.sampler.ms covers collection alone and missed a 26.4s average by measuring 2.3s of it.",
  },
  /** Metrics written in the last sample — a sudden drop means a collector broke. */
  samplerPoints: {
    name: "barry.sampler.points",
    unit: "count",
    description:
      "Metrics written in the last sample — a sudden drop means a collector broke.",
  },
  // Record collector health explicitly so failed commands do not look like empty readings.
  // Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-120
  collectorOk: {
    name: "barry.collector.ok",
    unit: "bool",
    description:
      "1 when a required command was found and ran, 0 when it could not. Exists because a missing binary is otherwise INVISIBLE: \"no data\" and \"broken\" must not look identical.",
  },

  // ── Alert delivery ──────────────────────────────────────────────────────
  //
  // `collectorOk` above applies the same principle to collection, and the gap
  // these close is the mirror image of it: collection was instrumented and
  // DELIVERY was not, so an alerting system could fail at the last step and
  // report nothing. notify() computed a per-send result the whole time and
  // both call sites discarded it; a measured 121-of-449 (28%) loss existed
  // only as stderr lines. The loss was also load-correlated — one send took
  // 5.2s idle and 53.4s at peak against a 30s timeout — so the channel worked
  // whenever there was nothing to say.
  //
  // Recorded per TICK, not per alert: the question is "is delivery working",
  // and one row per tick keeps that answerable without a series per rule.
  /** Notifications attempted this tick (alerts + recoveries). */
  notifyAttempts: {
    name: "barry.notify.attempts",
    unit: "count",
    description: "Alerts and recoveries dispatched this tick. The denominator for notify failures.",
  },
  /** How many of those had at least one channel fail. */
  notifyFailures: {
    name: "barry.notify.failures",
    unit: "count",
    description:
      "Notifications this tick where a channel timed out or exited non-zero. Counted, not inferred from absence: rules cannot alert on a series going quiet, so the failure has to be a number that rises.",
  },
  /** 1 when every channel of every notification this tick got through. */
  notifyOk: {
    name: "barry.notify.ok",
    unit: "bool",
    description:
      "1 when every notification this tick reached every channel it tried, 0 when any failed. The alerting system's own health — deliberately a stored metric rather than an alert, because a delivery failure announced through the failing channel cannot report itself.",
  },

  // ── Record hooks ────────────────────────────────────────────────────────
  //
  // A bag can declare `hooks.barry` and have its script run when a Barry event
  // is created. The hook runs in another process, its failures are contained
  // on purpose, and the event is durable either way — so a hook that silently
  // stops running changes NOTHING observable. That is the shape this bag calls
  // a check that cannot fail, and these are what make it fail loudly.
  //
  // `hookDispatches` is written on EVERY dispatch, including when no bag
  // declares a hook. That is the load-bearing part: `no-data` detects a series
  // that STOPPED, and a metric written only when a hook exists would be
  // indistinguishable between "nobody subscribes" and "the seam is dead".
  // Writing the zero makes the seam itself the subject.
  /** Dispatches attempted since this process started. The denominator. */
  hookDispatches: {
    name: "barry.hooks.dispatches",
    unit: "count",
    description:
      "Record-hook dispatches attempted, cumulative. Written on every event even when no bag declares a hook, so the seam going quiet is distinguishable from nobody subscribing.",
  },
  /** How many hook runs failed — non-zero exit, spawn error or timeout. */
  hookFailures: {
    name: "barry.hooks.failures",
    unit: "count",
    description:
      "Record-hook runs that failed, cumulative, labelled by bag. Counted rather than inferred from absence: a hook's failure is contained by design, so nothing else about the system changes when one breaks.",
  },

  // ── Ollama ──────────────────────────────────────────────────────────────
  //
  // Ollama is the largest memory consumer Barry causes and, until these, the
  // only one attributed to nobody: it is a user-quittable GUI app, not a
  // `com.barry.*` launchd label, so service discovery cannot see it. Its
  // `llama-server` child holds 4-6GB per inference on a 16GB machine.
  //
  // Reachability is NOT a metric of its own — it is `collectorOk{tool:"ollama"}`,
  // reusing the mechanism that already exists for exactly this question.
  // Use daemon-reported resident model size rather than inferring it from a process name.
  // Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-121
  ollamaLoadedMb: {
    name: "barry.ollama.loaded_mb",
    unit: "MB",
    description:
      "Resident size of loaded Ollama models. The unlabelled total is continuous and reads 0 when idle, so it stays alertable; per-model series stop when a model unloads.",
  },
  // Expiry is daemon time minus observation time, distinct from model activity.
  // Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-122
  ollamaModelExpiresSec: {
    name: "barry.ollama.model_expires_sec",
    unit: "s",
    description:
      "Seconds until Ollama unloads a loaded model. Explains spawn churn — a short keep-alive means a 4-6GB reload on most ticks.",
  },
  /** 1 when the model the bookkeeping job needs is installed, from `/api/tags`. */
  ollamaModelInstalled: {
    name: "barry.ollama.model_installed",
    unit: "bool",
    description:
      "1 when the model session bookkeeping needs is present in `ollama list`. A missing model makes that job skip forever, silently.",
  },

  // ── Session bookkeeping ─────────────────────────────────────────────────
  //
  // Derived by parsing the job's own summary line out of jobs.db `output_tail`.
  // The sessions bag is in a different repo; this reads what it already writes
  // rather than coupling the two. `bookkeepingParseOk` is what keeps that
  // honest — see its own note.
  /** Entries written on the last run. */
  bookkeepingWritten: {
    name: "barry.bookkeeping.written",
    unit: "count",
    description: "Session ledger entries written on the last bookkeeping run.",
  },
  /** Model calls that failed on the last run. */
  bookkeepingFailed: {
    name: "barry.bookkeeping.failed",
    unit: "count",
    description: "Model calls that failed on the last bookkeeping run.",
  },
  /** Sessions deferred because the run hit its per-tick write cap. */
  bookkeepingDeferred: {
    name: "barry.bookkeeping.deferred",
    unit: "count",
    description:
      "Sessions deferred by the per-tick write cap. A rising floor means inference is not keeping up with the 15-minute schedule.",
  },
  /** Median inference latency on the last run. */
  ollamaInferenceP50Sec: {
    name: "barry.ollama.inference_p50_sec",
    unit: "s",
    description:
      "Median inference latency on the last bookkeeping run. Rises early when the host is under memory pressure, because a swapping machine slows inference first.",
  },
  // Report summary parse success separately from the values parsed.
  // Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-123
  bookkeepingParseOk: {
    name: "barry.bookkeeping.parse_ok",
    unit: "bool",
    description:
      "1 when the bookkeeping summary line parsed, 0 when it did not. Without it a changed log format charts as zeros, which reads as a quiet job rather than a broken parser.",
  },
} as const;

export type MetricName = (typeof METRICS)[keyof typeof METRICS]["name"];

/** One observation. `labels` is the dimension map, serialized on write. */
export interface MetricPoint {
  // Metric timestamps are UNIX seconds throughout storage and retention.
  // Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-124
  ts: number;
  metric: string;
  value: number;
  labels?: Record<string, string>;
}

// Retain raw recent data and bounded hourly history so monthly trends remain answerable.
// Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-125
export const RETENTION = {
  /** Raw points older than this are rolled up and deleted. */
  rawDays: 7,
  /** Hourly buckets older than this are deleted outright. */
  hourlyDays: 90,
} as const;

/** Canonical serialization for a label set, so the same dimensions always key identically. */
export function labelKey(labels?: Record<string, string>): string {
  if (!labels) return "{}";
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "{}";
  // Sorted so {a,b} and {b,a} are one series rather than two.
  return JSON.stringify(Object.fromEntries(keys.map((k) => [k, labels[k]])));
}
