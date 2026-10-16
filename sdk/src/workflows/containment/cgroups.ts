import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

export interface CgroupConfig {
  memoryMaxBytes?: number;
  pidsMax?: number;
  cpuQuotaPercent?: number;
}

export interface SpawnInvocation {
  command: string;
  args: string[];
}

/**
 * Linux cgroups v2 containment provider.
 * Verifies a delegated systemd user scope by observing its enforced limits.
 * There is no direct cgroupfs fallback.
 */
export class CgroupContainment {
  readonly isAvailable: boolean;
  readonly mode: "systemd" | "unsupported";

  constructor(private readonly config: CgroupConfig = {}) {
    if (process.platform !== "linux") {
      this.isAvailable = false;
      this.mode = "unsupported";
      return;
    }

    this.isAvailable = false;
    this.mode = "unsupported";
    if (!existsSync("/sys/fs/cgroup/cgroup.controllers")) return;
    // A mounted hierarchy does not establish delegation, a working user manager,
    // or enabled resource controllers. Execute a bounded disposable probe and
    // read the limits from inside its actual scope before advertising support.
    const properties = this.properties();
    const probe = `const fs=require("node:fs"); const group=fs.readFileSync("/proc/self/cgroup","utf8").trim().split("\\n").find(line=>line.startsWith("0::")).slice(3); const root="/sys/fs/cgroup"+group; const read=name=>fs.existsSync(root+name)?fs.readFileSync(root+name,"utf8").trim():null; console.log(JSON.stringify({group,memory:read("/memory.max"),swap:read("/memory.swap.max"),pids:read("/pids.max"),cpu:read("/cpu.max")}));`;
    try {
      const observed = JSON.parse(
        execFileSync(
          "systemd-run",
          ["--user", "--scope", "-q", ...properties, process.execPath, "-e", probe],
          { encoding: "utf8", timeout: 5000, maxBuffer: 16384, stdio: ["ignore", "pipe", "pipe"] },
        ),
      ) as { group: string; memory: string; swap: string; pids: string; cpu: string | null };
      const [quota, period] = (observed.cpu ?? "").split(" ").map(Number);
      if (
        !observed.group.endsWith(".scope") ||
        (config.memoryMaxBytes &&
          (Number(observed.memory) !== config.memoryMaxBytes || observed.swap !== "0")) ||
        (config.pidsMax && Number(observed.pids) !== config.pidsMax) ||
        (config.cpuQuotaPercent &&
          (!Number.isFinite(quota) ||
            !(period > 0) ||
            Math.abs((quota / period) * 100 - config.cpuQuotaPercent) > 0.01))
      )
        return;
      this.isAvailable = true;
      this.mode = "systemd";
    } catch {
      /* Unsupported delegation or resource limits: fail closed. */
    }
  }

  private properties(): string[] {
    const systemdArgs: string[] = [];
    if (this.config.memoryMaxBytes) {
      systemdArgs.push(`-p`, `MemoryMax=${this.config.memoryMaxBytes}`);
      // Bound resident and swapped memory together. MemoryHigh throttling can
      // stall allocation indefinitely before the hard limit is reached.
      systemdArgs.push(`-p`, "MemorySwapMax=0");
    }
    if (this.config.pidsMax) {
      systemdArgs.push(`-p`, `TasksMax=${this.config.pidsMax}`);
    }
    if (this.config.cpuQuotaPercent) {
      systemdArgs.push(`-p`, `CPUQuota=${this.config.cpuQuotaPercent}%`);
    }

    return systemdArgs;
  }

  /**
   * Wraps spawn command with cgroups v2 confinement.
   * If on Linux under systemd, prefixes with systemd-run --user --scope.
   * If hardened containment is requested and unavailable, refuses execution rather than silently falling back.
   */
  wrapSpawn(command: string, args: string[], options?: { hardened?: boolean }): SpawnInvocation {
    if (options?.hardened && (!this.isAvailable || this.mode === "unsupported")) {
      throw new Error(
        `Hardened containment required, but cgroups v2 containment is unavailable on platform "${process.platform}"`,
      );
    }
    if (!this.isAvailable || this.mode !== "systemd") {
      return { command, args };
    }

    const systemdArgs = ["--user", "--scope", "-q", ...this.properties()];

    return {
      command: "systemd-run",
      args: [...systemdArgs, command, ...args],
    };
  }
}
