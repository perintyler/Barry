import { existsSync } from "node:fs";
import { ServiceRefusal } from "./management.js";
import { isAlive } from "@barry-rocks/sdk/internal/services";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

export interface JobState {
  loaded: boolean;
  pid?: number;
  state?: string;
  runs?: number;
  lastExitCode?: number;
}
export interface ServiceOS {
  canControl?(domain: string): boolean;
  inspect(domain: string, label: string): JobState;
  observe?(domain: string, label: string): Promise<JobState>;
  load(domain: string, plist: string): void;
  unload(domain: string, label: string, timeoutMs: number): Promise<void>;
  enable(domain: string, label: string, enabled: boolean): void;
  start(domain: string, label: string): void;
  policy?(domain: string, label: string): boolean;
}
export type Launchctl = (args: readonly string[]) => string;
/** No OS calls occur until an operation is invoked. Only known absence errors are ignored. */
export function launchd(
  run?: Launchctl,
): ServiceOS {
  const execute: Launchctl = run ?? ((args) =>
    execFileSync("/bin/launchctl", [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }));
  const executeAsync = run
    ? async (args: readonly string[]) => run(args)
    : async (args: readonly string[]) => (await promisify(execFile)("/bin/launchctl", [...args], { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" })).stdout;
  const absent = (error: unknown) =>
    /Could not find service|No such process|Could not find specified service/i.test(
      String((error as { stderr?: unknown }).stderr ?? error),
    );
  const parse = (output: string): JobState => {
    const pid = /\bpid = (\d+)/.exec(output)?.[1];
    const runs = /\bruns = (\d+)/.exec(output)?.[1];
    const lastExit = /\blast exit code = (-?\d+)/.exec(output)?.[1];
    return {
      loaded: true,
      ...(pid ? { pid: Number(pid) } : {}),
      state: /\bstate = ([^\n]+)/.exec(output)?.[1]?.trim(),
      ...(runs ? { runs: Number(runs) } : {}),
      ...(lastExit ? { lastExitCode: Number(lastExit) } : {}),
    };
  };
  const inspect = (domain: string, label: string): JobState => {
    try {
      return parse(execute(["print", `${domain}/${label}`]));
    } catch (error) {
      if (absent(error)) return { loaded: false };
      throw error;
    }
  };
  return {
    canControl: (domain) => domain !== "system" || process.getuid?.() === 0,
    inspect,
    observe: async (domain, label) => {
      try { return parse(await executeAsync(["print", `${domain}/${label}`])); }
      catch (error) { if (absent(error)) return { loaded: false }; throw error; }
    },
    policy: (domain, label) => {
      const output = execute(["print-disabled", domain]);
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`"${escaped}"\\s*=>\\s*true`).test(output)
        ? false
        : true;
    },
    load: (domain, plist) => {
      execute(["bootstrap", domain, plist]);
    },
    enable: (domain, label, enabled) => {
      execute([enabled ? "enable" : "disable", `${domain}/${label}`]);
    },
    start: (domain, label) => {
      execute(["kickstart", `${domain}/${label}`]);
    },
    async unload(domain, label, timeoutMs) {
      const pid = inspect(domain, label).pid;
      try {
        execute(["bootout", `${domain}/${label}`]);
      } catch (error) {
        if (!absent(error)) throw error;
      }
      const deadline = performance.now() + timeoutMs;
      while (
        inspect(domain, label).loaded ||
        (pid !== undefined && isAlive(pid))
      ) {
        if (performance.now() >= deadline)
          throw new Error(
            `launchd did not unload ${label} within ${timeoutMs}ms`,
          );
        await delay(100);
      }
    },
  };
}

/** Unsupported hosts still accept durable registration policy without starting anything. */
export function inertServiceOS(): ServiceOS {
  const policies = new Map<string, boolean>();
  const refuse = () => { throw new ServiceRefusal("unsupported", "services need launchd or systemd; this host has neither"); };
  return {
    canControl: domain => domain !== "system",
    inspect: () => ({ loaded: false, state: "unsupported" }),
    enable: (domain, label, enabled) => { policies.set(`${domain}/${label}`, enabled); },
    policy: (domain, label) => policies.get(`${domain}/${label}`) ?? false,
    load: refuse,
    start: refuse,
    unload: async () => refuse(),
  };
}

/** One selection boundary; systemd support can join this interface when available. */
export function serviceOS(platform: NodeJS.Platform = process.platform, exists: (path: string) => boolean = existsSync): ServiceOS {
  return platform === "darwin" && exists("/bin/launchctl") ? launchd() : inertServiceOS();
}
