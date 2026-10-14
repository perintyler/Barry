import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import type { ServiceManagement } from "./management.js";

/** An application probe is distinct from the OS's process observation. */
export async function probeHealth(
  address: string | undefined,
  path: string | undefined,
): Promise<"ok" | "failing" | "unknown"> {
  if (!address || !path) return "unknown";
  if (address.startsWith("unix:")) {
    return new Promise((resolve) => {
      const req = request(
        {
          socketPath: decodeURIComponent(new URL(address).pathname),
          path,
          timeout: 5000,
        },
        (response) => {
          response.resume();
          resolve(
            response.statusCode &&
              response.statusCode >= 200 &&
              response.statusCode < 300
              ? "ok"
              : "failing",
          );
        },
      );
      req.on("timeout", () => req.destroy(new Error("health probe timed out")));
      req.on("error", () => resolve("failing"));
      req.end();
    });
  }
  if (!address.startsWith("http")) return "unknown";
  try {
    return (
      await fetch(new URL(path, address), { signal: AbortSignal.timeout(5000) })
    ).ok
      ? "ok"
      : "failing";
  } catch {
    return "failing";
  }
}
/** Preparation and process creation never stand in for application readiness. */
export async function waitForServices(
  management: ServiceManagement,
  names: readonly string[],
  addresses: Readonly<Record<string, { url?: string }>>,
  timeoutMs = 60000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let remaining = [...names];
  do {
    const ready = await Promise.all(
      remaining.map(async (name) => {
        const state = await management.status(name),
          definition = management.definition(name);
        if (!state.pid || state.pending) return false;
        return (
          !definition.health ||
          (await probeHealth(addresses[name]?.url, definition.health)) === "ok"
        );
      }),
    );
    remaining = remaining.filter((_name, index) => !ready[index]);
    if (!remaining.length) return;
    if (Date.now() >= deadline) break;
    await delay(Math.min(250, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Error(`services did not become ready: ${remaining.join(", ")}`);
}
