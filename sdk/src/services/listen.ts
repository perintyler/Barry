/**
 * Listen only on the service-management-assigned port and loopback address; the service-address checker enforces use of this helper.
 * See docs/decisions/0011-sdk-runtime-invariants.md for the retained rationale.
 */
import type { Server } from "node:http";

/** Services bind here. Hosting providers reach them from loopback too; see core auth. */
export const LOOPBACK = "127.0.0.1";

/**
 * The port service management assigned, from `PORT`.
 *
 * Refuses to guess: a service started without `PORT` was not started by
 * `barry up`, and a fallback number is exactly how a second copy of a service
 * ends up answering on the real one's port.
 */
export function assignedPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PORT;
  if (raw === undefined || raw === "") {
    throw new Error(
      "PORT is not set. Barry services are started by `barry up`, which assigns each one a port; " +
        "run it through service management (or set PORT yourself to try it by hand).",
    );
  }
  // 0 asks the OS for any free port: a test starting a server of its own uses
  // it, and service management never assigns it.
  if (!/^\d+$/.test(raw) || Number(raw) > 65535) {
    throw new Error(`PORT must be a port number, got "${raw}"`);
  }
  return Number(raw);
}

/** Anything with Node's `listen(port, host, callback)`: an http.Server, or an Express app. */
export interface Listenable {
  listen(port: number, hostname: string, callback: () => void): unknown;
}

/**
 * Listen on the assigned port, on loopback. Resolves with the server once it
 * is accepting connections; rejects, naming the port, if it cannot bind.
 *
 * Accepts an Express app as well as a server: `app.listen` returns the server
 * it creates, and that is what this resolves with.
 */
export function listenOnAssignedPort(target: Listenable, env: NodeJS.ProcessEnv = process.env): Promise<Server> {
  const port = assignedPort(env);
  return new Promise((resolve, reject) => {
    // Filled in once listen() returns; the callback below can fire only after that.
    const bound: { server?: Server } = {};
    const onError = (err: NodeJS.ErrnoException) => {
      reject(
        err.code === "EADDRINUSE"
          ? new Error(
              `port ${port} is already in use on ${LOOPBACK}. Service management assigned it; ` +
                "`barry service status` names what holds it.",
            )
          : err,
      );
    };
    const returned = target.listen(port, LOOPBACK, () => {
      const s = bound.server ?? (isServer(target) ? target : undefined);
      s?.off("error", onError);
      if (!s) {
        reject(new Error("listenOnAssignedPort: listen() returned no server to hand back"));
        return;
      }
      resolve(s);
    });
    bound.server = isServer(returned) ? returned : isServer(target) ? target : undefined;
    bound.server?.once("error", onError);
  });
}

function isServer(value: unknown): value is Server {
  return Boolean(value) && typeof (value as Server).address === "function" && typeof (value as Server).once === "function";
}
