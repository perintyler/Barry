/**
 * `barry service logs [service]`: a service's output, from the files the
 * launchd writes (`~/Library/Logs/Barry/<bag>/`). Without a service, the
 * last lines of every service's stderr, which is where a failure shows first.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { serviceRequest } from "@barry-rocks/mcp-bag";
import { rotateLog, tailLog } from "@barry-rocks/mcp-bag";
import { bold, dim } from "../lib/ansi.js";
import { resolveServiceNames } from "./service.js";

export interface LogsOptions {
  follow?: boolean;
  lines?: string;
  stderr?: boolean;
  rotate?: boolean;
}

/**
 * `tail -F` in Node: print the last `lines`, then follow appends, re-opening
 * across a rotation (which renames the file, so the inode we held stops
 * growing). No `/usr/bin/tail`, which does not exist on Linux where read-only
 * commands still run.
 */
async function followLog(path: string, lines: number): Promise<void> {
  const seed = tailLog(path, lines);
  if (seed) console.log(seed);
  let offset = existsSync(path) ? statSync(path).size : 0;
  const decoder = new TextDecoder();
  await new Promise<void>((resolve) => {
    let closed = false;
    const stop = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    const pump = () => {
      try {
        if (!existsSync(path)) return;
        const size = statSync(path).size;
        // A smaller file than last read is a rotation (or truncation): start over.
        if (size < offset) offset = 0;
        if (size === offset) return;
        const fd = openSync(path, "r");
        try {
          const buffer = Buffer.alloc(size - offset);
          readSync(fd, buffer, 0, buffer.length, offset);
          offset = size;
          process.stdout.write(decoder.decode(buffer, { stream: true }));
        } finally {
          closeSync(fd);
        }
      } catch {
        // Transient read error during a rotation; the next tick retries.
      }
    };
    const timer = setInterval(pump, 200);
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

export async function logsCommand(
  service: string | undefined,
  options: LogsOptions = {},
): Promise<void> {
  const lines = Number(options.lines ?? "50");
  const { services } = await serviceRequest({ op: "status" });

  if (options.rotate && (!service || options.follow))
    throw new Error(
      "rotation requires one stopped service and cannot be combined with --follow",
    );
  if (!service) {
    for (const s of [...services].sort((a, b) => a.key.localeCompare(b.key))) {
      const path = s.stderrLog;
      if (!path || !existsSync(path)) continue;
      const tail = tailLog(path, Math.min(lines, 10));
      if (!tail) continue;
      console.log(`\n${bold(s.key)} ${dim(path)}`);
      console.log(tail);
    }
    return;
  }

  const [key] = resolveServiceNames([service], services);
  const status = services.find((s) => s.key === key)!;
  const path = options.stderr ? status.stderrLog : status.stdoutLog;
  if (!path) throw new Error(`service management reports no log for ${key}`);
  if (options.rotate) {
    const { installedServices } = await import("../services/barry.js");
    const management = await installedServices();
    if ((await management.status(key)).loaded)
      throw new Error("stop the service before rotating its logs");
    rotateLog(path);
  }
  if (options.follow) {
    // Follow in Node, re-opening across rotations, rather than spawning tail.
    await followLog(path, lines);
    return;
  }
  console.log(
    existsSync(path) ? tailLog(path, lines) : dim(`(no output yet at ${path})`),
  );
}
