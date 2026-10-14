/** Process observations are independent of registration and launch policy. */
export type ServiceState =
  /** Spawned; its health path has not answered yet. */
  | "starting"
  | "running"
  /** Exited; waiting out its backoff before the next start. */
  | "backoff"
  /** Stopped on request, or `autostart: manual` and never started. */
  | "stopped"
  /** Its assigned port is held by another program; the holder is in `conflict`. */
  | "conflict"
  /** This host has no supported service supervisor. */
  | "unsupported";

/** One service combining instance policy, launchd observations and application probes. */
export interface ServiceStatus {
  /** Running files are uncapped; rotation occurs only while the job is unloaded. */
  logs?: { stdoutBytes: number; stderrBytes: number; rotationRecommended: boolean };
  /** Registry name, `<bag>.<service>`. */
  registered?: boolean;
  enabled?: boolean;
  pending?: string;
  key: string;
  bag: string;
  name: string;
  state: ServiceState;
  kind?: "service" | "app" | "container" | "deployment";
  system?: boolean;
  lastExitCode?: number;
  autostart: "login" | "manual";
  pid?: number;
  port?: number;
  url?: string;
  /** ISO time of the current process's start. */
  startedAt?: string;
  /** Where it runs, and what: its working directory and command line. */
  workingDirectory: string;
  argv: string[];
  /** Launches after the first, as reported by launchd for the loaded job. */
  restarts: number;
  /** The last health probe: `ok`, `failing`, or `unknown` when it has none or none ran yet. */
  health: "ok" | "failing" | "unknown";
  /**
   * False when the process listens on something other than loopback. A service bound to `*`
   * is reported, not silently exposed.
   */
  loopbackOnly?: boolean;
  /** For `conflict`: who holds the port, e.g. "node (pid 812)". */
  conflict?: string;
  /** Why it is not running, when management can observe it: a required key missing, a command not found. */
  problem?: string;
  stdoutLog?: string;
  stderrLog?: string;
}
