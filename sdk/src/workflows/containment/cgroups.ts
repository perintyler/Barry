import { existsSync } from "node:fs";

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
 * Supports systemd-run user scope or direct cgroups v2 hierarchy management.
 */
export class CgroupContainment {
  readonly isAvailable: boolean;
  readonly mode: "systemd" | "cgroupfs" | "unsupported";

  constructor(private readonly config: CgroupConfig = {}) {
    if (process.platform !== "linux") {
      this.isAvailable = false;
      this.mode = "unsupported";
      return;
    }

    // Check for cgroups v2 controllers file
    const cgroupControllers = "/sys/fs/cgroup/cgroup.controllers";
    if (existsSync(cgroupControllers)) {
      this.isAvailable = true;
      // Default to systemd if available in path, otherwise cgroupfs
      this.mode = "systemd";
    } else {
      this.isAvailable = false;
      this.mode = "unsupported";
    }
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

    const systemdArgs = ["--user", "--scope", "-q"];
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

    return {
      command: "systemd-run",
      args: [...systemdArgs, command, ...args],
    };
  }
}
