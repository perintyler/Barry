import { Barry, isBarryError, requestCaller } from "@barry-rocks/sdk";
import { loadRegistry } from "@barry-rocks/sdk/internal/bags";
import type { RemoteBagSource } from "@barry-rocks/sdk/bags";
import { createLogger } from "@barry-rocks/sdk/logging";
import { identitiesRoutes, identityUpdateOf } from "@barry-rocks/sdk/internal/routes";
import { serve } from "@barry-rocks/sdk/services/http";
import { getServiceUrl } from "@barry-rocks/sdk/services";
import { hasOAuthTokens } from "@barry-rocks/sdk/internal/vault";
import { Router, type Response } from "express";
import { spawn, type ChildProcess } from "node:child_process";
import { identityOf } from "./operations/identities.js";
import { identityRecords } from "./operations/identity-records.js";

const log = createLogger("barry-server");

/** The MCP engine, looked up per call so a moved engine is reached on the next request. */
const engineUrl = (): string => getServiceUrl("mcpBarry");

/**
 * Auth header for server-to-server calls into the MCP server.
 *
 * The MCP server rejects unauthenticated requests, so a proxy that forwards
 * nothing gets "Unauthorized: Missing or invalid BARRY_SECRET" — and the
 * catch blocks below turn that into an empty but ok:true payload, so the
 * Bags panel silently showed no status at all rather than an error.
 */
function mcpAuthHeaders(): Record<string, string> {
  return process.env.BARRY_SECRET
    ? { Authorization: `Bearer ${process.env.BARRY_SECRET}` }
    : {};
}

interface AuthProcess {
  child: ChildProcess;
  url: string;
  status: "pending" | "complete" | "failed";
  startedAt: number;
}

const activeAuths = new Map<string, AuthProcess>();

/** Resolve the MCP server URL for a remote bag */
function resolveBagUrl(source: RemoteBagSource): string | null {
  if (source.url) return source.url;
  if (source.command === "npx" && source.args) {
    const idx = source.args.indexOf("mcp-remote");
    if (idx >= 0 && source.args[idx + 1]?.startsWith("http")) {
      return source.args[idx + 1];
    }
  }
  return null;
}

/**
 * Spawn mcp-remote for OAuth, poll for token file, and call /bag-retry on success.
 */
function startBagAuth(name: string, url: string, source: RemoteBagSource): AuthProcess {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (source.env) {
    for (const v of source.env) {
      if (process.env[v]) env[v] = process.env[v]!;
    }
  }

  const args = ["-y", "mcp-remote", url];
  if (source.args) {
    const remoteIdx = source.args.indexOf("mcp-remote");
    if (remoteIdx >= 0) {
      for (let i = remoteIdx + 2; i < source.args.length; i++) {
        let arg = source.args[i];
        arg = arg.replace(/\$\{(\w+)\}/g, (_: string, v: string) => env[v] || "");
        args.push(arg);
      }
    }
  }

  const child = spawn("npx", args, { stdio: "pipe", env });

  const entry: AuthProcess = { child, url, status: "pending", startedAt: Date.now() };

  const AUTH_TIMEOUT_MS = 120_000;
  const POLL_INTERVAL_MS = 2_000;

  const poll = setInterval(async () => {
    if (entry.status !== "pending") return;
    if (hasOAuthTokens(url)) {
      entry.status = "complete";
      clearInterval(poll);
      clearTimeout(timeout);
      child.kill();
      activeAuths.delete(name);

      try {
        await fetch(`${engineUrl()}/bag-retry`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...mcpAuthHeaders() },
          body: JSON.stringify({ bag: name }),
        });
      } catch {
        log.warn("bag_auth.retry_failed", { bag: name });
      }
    }
  }, POLL_INTERVAL_MS);

  const timeout = setTimeout(() => {
    if (entry.status !== "pending") return;
    entry.status = "failed";
    clearInterval(poll);
    child.kill();
    activeAuths.delete(name);
  }, AUTH_TIMEOUT_MS);

  child.on("close", () => {
    if (entry.status === "pending") {
      // Process died before we detected tokens — check one more time
      if (hasOAuthTokens(url)) {
        entry.status = "complete";
      }
      clearInterval(poll);
      clearTimeout(timeout);
    }
  });

  return entry;
}

/** A body with the warnings a change raised, when it raised any. */
function withWarnings(body: Record<string, unknown>, warnings: readonly unknown[]): Record<string, unknown> {
  return warnings.length > 0 ? { ...body, warnings } : body;
}

/** Answer a refusal with its status, and anything else as the failure it is. */
function failed(res: Response, event: string, err: unknown, message: string): void {
  if (isBarryError(err)) {
    res.status(err.status).json({ ok: false, error: err.message, ...(err.hint ? { hint: err.hint } : {}) });
    return;
  }
  log.error(event, { error: err instanceof Error ? err.message : String(err) });
  res.status(500).json({ ok: false, error: message });
}

/**
 * The identities routes: parse the request, ask `Barry` as the request's
 * verified caller, answer its result. The service installs the identities and
 * sessions subjects, so removing an identity removes its sessions.
 */
export function createIdentitiesRouter(): Router {
  const router = Router();
  const routes = serve(router, "/identities");

  routes.route(identitiesRoutes.createIdentity, async (req, res) => {
    try {
      const valid = identitiesRoutes.createIdentity.body.safeParse(req.body);
      if (!valid.success) {
        res.status(400).json({ error: "Invalid identity creation input" });
        return;
      }
      // An identity is a directory; `source: "db"` is accepted from older
      // clients and makes one too.
      const { name, source: _source, ...fields } = valid.data;
      const { warnings, ...identity } = await Barry.as(requestCaller(req.authPrincipal)).createIdentity({ name, ...identityUpdateOf(fields) });
      res.status(201).json(withWarnings({ identity }, warnings));
    } catch (err) {
      failed(res, "identities.create_failed", err, "Failed to create identity");
    }
  });

  routes.route(identitiesRoutes.listIdentities, async (req, res) => {
    try {
      res.json({ identities: await Barry.as(requestCaller(req.authPrincipal)).identities() });
    } catch (err) {
      failed(res, "identities.list_failed", err, "Failed to list identities");
    }
  });

  routes.route(identitiesRoutes.getEffectiveIdentity, async (req, res) => {
    const repoPath = typeof req.query.repoPath === "string" ? req.query.repoPath : null;
    try {
      const { barry, source, repoRoot } = await identityRecords.resolve({ repoPath }, requestCaller(req.authPrincipal));
      res.json({
        identity: identityOf({ record: barry, source: source === "file" ? "file" : "db", dir: null, isDefault: source === "default" }),
        source,
        repoRoot,
      });
    } catch (err) {
      if (isBarryError(err)) {
        res.status(err.reason === "forbidden" ? 403 : 400).json({ error: err.message });
        return;
      }
      failed(res, "identities.effective_failed", err, "Failed to resolve the effective identity");
    }
  });


  /** Report MCP unavailability explicitly so callers can distinguish unknown health from a healthy authorized pool; see docs/decisions/0013-session-store-and-mcp-admission.md. */
  routes.route(identitiesRoutes.getBagStatus, async (req, res) => {
    const unavailable = (error: string) => {
      log.warn("identities.bag_status_unavailable", { error });
      res.json({
        ok: true,
        available: false,
        error,
        shared: [],
        needsAuth: [],
        authExpired: [],
        failed: [],
        deferred: [],
      });
    };

    try {
      // Forwarded so the MCP server can narrow the pool to what this session
      // actually reaches; omitted, it answers for the whole registry.
      const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "";
      const url = sessionId
        ? `${engineUrl()}/bag-status?sessionId=${encodeURIComponent(sessionId)}`
        : `${engineUrl()}/bag-status`;
      const response = await fetch(url, {
        headers: mcpAuthHeaders(),
      });
      // A non-2xx body is an error payload, not a status report. Spreading it
      // would let `{ error: ... }` masquerade as an all-clear.
      if (!response.ok) {
        unavailable(`MCP server returned HTTP ${response.status}`);
        return;
      }
      const data = await response.json();
      res.json({ ok: true, available: true, ...data });
    } catch (err) {
      unavailable(err instanceof Error ? err.message : String(err));
    }
  });

  routes.route(identitiesRoutes.retryBag, async (req, res) => {
    try {
      const response = await fetch(`${engineUrl()}/bag-retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...mcpAuthHeaders() },
        body: JSON.stringify({ bag: req.params.bagName }),
      });
      const data = await response.json();
      res.json(data);
    } catch (err) {
      log.warn("identities.bag_retry_failed", { error: err instanceof Error ? err.message : String(err) });
      res.status(502).json({ ok: false, error: "MCP server unavailable" });
    }
  });

  routes.route(identitiesRoutes.authorizeBag, async (req, res) => {
    const name = req.params.bagName;

    const existing = activeAuths.get(name);
    if (existing && existing.status === "pending") {
      res.json({ ok: true, status: "pending" });
      return;
    }

    try {
      const registry = loadRegistry();
      const source = registry[name];
      if (!source) {
        res.status(404).json({ ok: false, error: `Bag "${name}" not found` });
        return;
      }
      if (source.type !== "remote") {
        res.status(400).json({ ok: false, error: `Bag "${name}" is local -- no auth needed` });
        return;
      }

      const remote = source;
      const url = resolveBagUrl(remote);
      if (!url) {
        res.status(400).json({ ok: false, error: `Bag "${name}" has no MCP server URL` });
        return;
      }

      const entry = startBagAuth(name, url, remote);
      activeAuths.set(name, entry);

      // mcp-remote opens a browser on the local machine for OAuth consent
      res.json({ ok: true, status: "pending" });
    } catch (err) {
      log.error("identities.bag_auth_failed", { bag: name, error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ ok: false, error: "Failed to start bag auth" });
    }
  });

  routes.route(identitiesRoutes.getBagAuthStatus, async (req, res) => {
    const name = req.params.bagName;
    const entry = activeAuths.get(name);
    if (!entry) {
      res.json({ status: "not_started" });
      return;
    }
    res.json({ status: entry.status });
  });

  // GET /identities/bags/available - List all available bag names from registry
  // Registered before /:id to avoid Express matching "bags" as an ID param.
  routes.route(identitiesRoutes.listAvailableBags, async (_req, res) => {
    try {
      const bags = await Barry.as(requestCaller(_req.authPrincipal)).bags();
      res.json({ bags });
    } catch (err) {
      log.error("identities.bags_available_failed", { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ ok: false, error: "Failed to list available bags" });
    }
  });

  routes.route(identitiesRoutes.getIdentity, async (req, res) => {
    try {
      const ref = req.params.identity;
      res.json({ identity: await Barry.as(requestCaller(req.authPrincipal)).identity(ref).get() });
    } catch (err) {
      failed(res, "identities.get_failed", err, "Failed to get identity");
    }
  });

  routes.route(identitiesRoutes.updateIdentity, async (req, res) => {
    try {
      const ref = req.params.identity;
      const valid = identitiesRoutes.updateIdentity.body.safeParse(req.body);
      if (!valid.success) {
        res.status(400).json({ error: "Invalid identity update input" });
        return;
      }
      const identity = Barry.as(requestCaller(req.authPrincipal)).identity(ref);
      // An identity's name is the `name:` in its identity.yaml, which also
      // names its keychain accounts; renaming over the API would orphan them.
      if (typeof valid.data.name === "string" && valid.data.name.trim()) {
        const current = await identity.get();
        if (valid.data.name.trim() !== current.name) {
          res.status(409).json({
            ok: false,
            error: `"${current.name}" can't be renamed over the API`,
            hint: current.directory
              ? `Edit "name:" in ${current.directory}/identity.yaml. Keychain-backed secrets embed the old name and must be re-added.`
              : "Create a directory identity under the new name and delete this one.",
          });
          return;
        }
      }
      // The name was checked above and is not a change; the update takes the rest.
      const { name: _name, ...fields } = valid.data;
      const { warnings, ...updated } = await identity.update(identityUpdateOf(fields));
      res.json(withWarnings({ identity: updated }, warnings));
    } catch (err) {
      failed(res, "identities.update_failed", err, "Failed to update identity");
    }
  });

  routes.route(identitiesRoutes.setActiveIdentity, async (req, res) => {
    try {
      const ref = req.params.identity;
      await Barry.as(requestCaller(req.authPrincipal)).identity(ref).makeDefault();
      res.json({ ok: true });
    } catch (err) {
      failed(res, "identities.set_default_failed", err, "Failed to set the default identity");
    }
  });

  routes.route(identitiesRoutes.deleteIdentity, async (req, res) => {
    try {
      const ref = req.params.identity;
      const identity = Barry.as(requestCaller(req.authPrincipal)).identity(ref);
      const found = await identity.get();
      // A directory identity is often a repository of the user's own; removing
      // it is a terminal decision, not a click.
      if (found.directory) {
        res.status(400).json({
          ok: false,
          error: "This identity is a directory on disk and can't be deleted over the API",
          hint: `Run: barry identity delete ${found.name}`,
        });
        return;
      }
      const removed = await identity.remove();
      res.json({ ok: true, activeIdentity: removed.nextDefault });
    } catch (err) {
      failed(res, "identities.delete_failed", err, "Failed to delete identity");
    }
  });

  return router;
}
