/**
 * Memory browser.
 *
 * Plain node:http with no framework and no build step, the metrics-bag shape:
 * the place you go to curate what agents remember should keep working when
 * the rest of Barry does not.
 *
 * Binds loopback only, which is not a boundary: any local process, a sandboxed
 * agent session included, can reach it, and what it writes is what future
 * sessions are told. So everything but /health and the static assets needs
 * the instance secret, as a bearer token or a signed-in browser's cookie
 * (@barry-rocks/sdk/auth), as the metrics dashboard does.
 *
 * DELETE archives — hard deletion is deliberately not reachable over HTTP;
 * only the `forget` tool with hard=true does that.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@barry-rocks/sdk/logging";
import { handleSignIn, isAuthorized, SIGN_IN_PATH } from "@barry-rocks/sdk/auth";
import { installationSecrets } from "@barry-rocks/sdk/internal/services";
import { listenOnAssignedPort, assignedPort } from "@barry-rocks/sdk/services";
import { closeDb, getDbPath } from "../../src/db.js";
import {
  countMemories,
  getMemory,
  listRepos,
  listTags,
  saveMemory,
  searchMemories,
  updateMemory,
  type MemoryMode,
} from "../../src/store.js";

const log = createLogger("memory");
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Files servable from web/, by explicit allowlist rather than a path join —
 * `join(HERE, "..", "web", url.pathname)` is a directory traversal, and
 * "binds loopback today" is not a security boundary.
 */
const STATIC_ASSETS: Record<string, { file: string; type: string }> = {
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
};

/**
 * Reopen when the file on disk is replaced: SQLite handles follow the inode,
 * so a handle opened at boot keeps serving a deleted snapshot forever after a
 * reset or restore. One stat per request keeps the browser honest.
 */
let dbInode = currentInode();

function currentInode(): number | null {
  try {
    return statSync(getDbPath()).ino;
  } catch {
    return null;
  }
}

function checkDbFreshness(): void {
  const ino = currentInode();
  if (ino !== null && dbInode !== null && ino !== dbInode) {
    closeDb();
    log.info("memory db was replaced on disk; reopened");
  }
  dbInode = ino;
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {});
      } catch (err) {
        // JSON.parse throws a SyntaxError, but `err` is typed `unknown` and a
        // non-Error rejection loses the message at the `String(err)` handler.
        reject(err instanceof Error ? err : new Error(`invalid JSON body: ${String(err)}`));
      }
    });
    req.on("error", reject);
  });
}

function asTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((t): t is string => typeof t === "string");
}

function asMode(value: unknown): MemoryMode | undefined {
  return value === "always" || value === "on-demand" ? value : undefined;
}

/**
 * The instance secret every request but /health and the assets must carry.
 *
 * From the environment when the service definition injects it. A definition
 * recorded before this bag declared `secrets: [BARRY_SECRET]` does not, and
 * the browser would refuse every request until setup ran again; so the
 * installation's own store is asked instead. Only a found secret is kept, so a
 * failed read is retried on the next request rather than refusing forever.
 */
let storedSecret: string | undefined;
async function instanceSecret(): Promise<string> {
  // Read per request, so a test can set it after importing this module.
  if (process.env.BARRY_SECRET) return process.env.BARRY_SECRET;
  if (storedSecret) return storedSecret;
  try {
    storedSecret = (await installationSecrets(["BARRY_SECRET"], { optionalNames: ["BARRY_SECRET"] })).BARRY_SECRET || undefined;
  } catch (err) {
    log.warn("memory.secret_unavailable", { error: err instanceof Error ? err.message : String(err) });
  }
  return storedSecret ?? "";
}

/** Exported so tests drive the real routing table, not a copy of it. */
export const server = createServer(async (req, res) => {
  // The base is only for URL parsing; the port doesn't matter for relative paths.
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const method = req.method ?? "GET";

  try {
    if (url.pathname === "/health") {
      checkDbFreshness();
      return json(res, { ok: true, service: "barry-memory", memories: countMemories() });
    }

    const asset = STATIC_ASSETS[url.pathname];
    if (asset) {
      const body = readFileSync(join(HERE, "..", "..", "web", asset.file), "utf8");
      res.writeHead(200, { "content-type": asset.type });
      return res.end(body);
    }

    const secret = await instanceSecret();
    if (!secret) {
      return json(res, { error: "the memory browser has no BARRY_SECRET, so it refuses every request" }, 500);
    }
    if (url.pathname === SIGN_IN_PATH) {
      await handleSignIn(req, res, secret, "Memory");
      return;
    }
    if (!isAuthorized(req, secret)) {
      if (url.pathname.startsWith("/api/")) return json(res, { error: "unauthorized", signIn: SIGN_IN_PATH }, 401);
      // A page: send the browser to sign in, which sends it back to /.
      res.writeHead(303, { location: SIGN_IN_PATH, "cache-control": "no-store" });
      return res.end();
    }

    if (url.pathname === "/api/memories" && method === "GET") {
      checkDbFreshness();
      const repoParam = url.searchParams.get("repo");
      const results = searchMemories({
        query: url.searchParams.get("query") ?? undefined,
        // "global" selects only unscoped rows; a slug selects that repo ∪ global.
        repo: repoParam === "global" ? null : (repoParam ?? undefined),
        includeGlobal: repoParam === "global" ? undefined : true,
        allRepos: !repoParam,
        tags: url.searchParams.get("tags")?.split(",").filter(Boolean),
        mode: asMode(url.searchParams.get("mode")),
        includeArchived: url.searchParams.get("archived") === "1",
        limit: Number(url.searchParams.get("limit") ?? 100),
      });
      return json(res, { count: results.length, results });
    }

    if (url.pathname === "/api/memories" && method === "POST") {
      const body = await readJson(req);
      if (typeof body.title !== "string" || !body.title.trim() ||
          typeof body.body !== "string" || !body.body.trim()) {
        return json(res, { error: "title and body are required strings" }, 400);
      }
      const memory = saveMemory({
        title: body.title.trim(),
        body: body.body,
        repo: typeof body.repo === "string" && body.repo ? body.repo : null,
        tags: asTags(body.tags),
        mode: asMode(body.mode),
        source: "manual",
      });
      return json(res, memory, 201);
    }

    const idMatch = /^\/api\/memories\/([^/]+)$/.exec(url.pathname);
    if (idMatch) {
      const id = decodeURIComponent(idMatch[1]);

      if (method === "GET") {
        const memory = getMemory(id, { touch: false });
        return memory ? json(res, memory) : json(res, { error: "not found" }, 404);
      }

      if (method === "PATCH") {
        const body = await readJson(req);
        const result = updateMemory(id, {
          title: typeof body.title === "string" ? body.title : undefined,
          body: typeof body.body === "string" ? body.body : undefined,
          repo: body.repo === null ? null : typeof body.repo === "string" ? body.repo : undefined,
          tags: asTags(body.tags),
          mode: asMode(body.mode),
          archived: typeof body.archived === "boolean" ? body.archived : undefined,
        });
        return "error" in result
          ? json(res, { error: "not found" }, 404)
          : json(res, result.memory);
      }

      if (method === "DELETE") {
        // Archive, not delete: the UI's remove is always recoverable.
        const result = updateMemory(id, { archived: true });
        return "error" in result
          ? json(res, { error: "not found" }, 404)
          : json(res, { id, archived: true });
      }
    }

    if (url.pathname === "/api/tags") {
      return json(res, { tags: listTags({ allRepos: true }) });
    }

    if (url.pathname === "/api/repos") {
      return json(res, { repos: listRepos() });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      // Read per request rather than cached at boot: editing the page during
      // development should not need a service restart.
      const html = readFileSync(join(HERE, "..", "..", "web", "index.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  } catch (err) {
    log.error(`request ${url.pathname} failed: ${String(err)}`);
    json(res, { error: String(err) }, 500);
  }
});

listenOnAssignedPort(server).then(
  () => {
    log.info(`memory browser on http://127.0.0.1:${assignedPort()}`);
  },
  (err) => {
    log.error(`memory browser failed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
