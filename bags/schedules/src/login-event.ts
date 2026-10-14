import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

interface LoginEventOptions {
  platform?: string;
  uid?: number;
  run?: (command: string, args: string[]) => string;
  readFile?: (path: string) => string;
}

/** An OS login session, stable across service restarts and unique across reboots. */
export function loginEventId(options: LoginEventOptions = {}): string | null {
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) return null;
  const run = options.run ?? ((command, args) => execFileSync(command, args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, maxBuffer: 2 * 1024 * 1024,
  }).trim());
  const readFile = options.readFile ?? (path => readFileSync(path, "utf8").trim());
  try {
    switch (options.platform ?? process.platform) {
      case "darwin": {
        const domain = run("/bin/launchctl", ["print", `gui/${uid}`]);
        if (!/^\s*type = login\s*$/m.test(domain)) return null;
        const security = /security context = \{([^}]+)\}/.exec(domain)?.[1];
        const session = security && /^\s*asid = (\d+)\s*$/m.exec(security)?.[1];
        const owner = security && /^\s*uid = (\d+)\s*$/m.exec(security)?.[1];
        const boot = run("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]);
        if (!session || Number(session) === 0 || Number(owner) !== uid || !/^[a-f0-9-]{36}$/i.test(boot)) return null;
        return `darwin:${boot}:${uid}:${session}`;
      }
      case "linux": {
        const display = run("loginctl", ["show-user", String(uid), "--property=Display", "--value"]);
        if (!/^[a-zA-Z0-9_-]+$/.test(display)) return null;
        const properties = Object.fromEntries(run("loginctl", ["show-session", display,
          "--property=Id", "--property=User", "--property=Type", "--property=TimestampMonotonic",
        ]).split("\n").map(line => { const separator = line.indexOf("="); return [line.slice(0, separator), line.slice(separator + 1)]; }));
        const boot = readFile("/proc/sys/kernel/random/boot_id");
        if (properties.Id !== display || Number(properties.User) !== uid || !["x11", "wayland"].includes(properties.Type)
          || !/^\d+$/.test(properties.TimestampMonotonic) || !/^[a-f0-9-]{36}$/i.test(boot)) return null;
        return `linux:${boot}:${uid}:${display}:${properties.TimestampMonotonic}`;
      }
      default: return null;
    }
  } catch {
    // No verified login event means no login fire; never infer one from startup.
    return null;
  }
}
