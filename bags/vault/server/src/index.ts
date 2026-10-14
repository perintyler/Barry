/** Run the vault under its dedicated UID on a permission-controlled Unix socket; see docs/decisions/0016-vault-daemon-boundaries.md. */

import { vaultPaths } from "../../src/paths.js";

import { cleanup, closeDb } from "../../src/db.js";
import { app } from "./app.js";
import { listen, cleanupSocket } from "./listen.js";

const SOCKET_PATH = vaultPaths().socket;

const servers = listen(app, { socketPath: SOCKET_PATH });

/**
 * Hourly sweep of expired rate-limit and revoked-token rows.
 *
 * Lived beside the old server's `listen()` call; it belongs with the process
 * lifecycle rather than the request handler, so it moved here with it. Without
 * it both tables grow without bound. `unref`ed so it never holds the process
 * open on its own.
 */
const cleanupTimer = setInterval(cleanup, 60 * 60 * 1000);
cleanupTimer.unref();

/**
 * Close listeners and remove the socket before exiting.
 *
 * launchd SIGTERMs a service it is restarting, and a socket left behind is the
 * difference between a clean restart and one that has to clear a stale inode
 * first. `unref`ed so a hung connection cannot hold the process open forever.
 */
const shutdown = (): void => {
  clearInterval(cleanupTimer);
  for (const server of servers) server.close();
  cleanupSocket(SOCKET_PATH);
  closeDb();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
