import { describe, expect, it } from "vitest";
import type { Router } from "express";
import { servedRoutes } from "@barry-rocks/sdk/services/http";
import { INTERNAL_ROUTES } from "./internal-routes.js";

/**
 * SES-14: every registered API route must be either in the published OpenAPI
 * contract (declared through `serve(...).route`) or in the `INTERNAL_ROUTES`
 * list. A raw `router.get/post(...)` added without a declaration and without
 * being listed as deliberately-internal fails this test — closing the gap where
 * ~25 routes sat outside the contract with nothing naming them.
 *
 * The routers are imported and inspected rather than the whole app mounted:
 * each is read with the mount prefix `api/src/index.ts` gives it.
 */

const ROUTER_TREE_IMPORT_TIMEOUT_MS = 30_000;

function expressStack(router: Router): unknown[] {
  if ("stack" in router && Array.isArray((router as { stack?: unknown[] }).stack)) {
    return (router as { stack: unknown[] }).stack;
  }
  return [];
}

interface Registered {
  method: string;
  path: string;
}

/** Raw express routes declared on a router, as full mounted paths. */
function rawRoutes(router: Router, prefix: string): Registered[] {
  const out: Registered[] = [];
  for (const layer of expressStack(router) as Array<{ route?: { path?: string; methods?: Record<string, boolean> } }>) {
    const path = layer.route?.path;
    if (!path) continue;
    const full = `${prefix}${path === "/" ? "" : path}`;
    for (const [method, enabled] of Object.entries(layer.route?.methods ?? {})) {
      if (enabled && method !== "_all") out.push({ method: method.toLowerCase(), path: full });
    }
  }
  return out;
}

/** OpenAPI-contracted routes on a router, as full mounted paths. */
function declaredRoutes(router: Router, prefix: string): Registered[] {
  // The declaration path is the full `/sessions/...` form; the router is mounted
  // at `/api/v1`, so the declared path becomes `/api/v1` + declaration path.
  return servedRoutes(router).map((r) => ({ method: r.method.toLowerCase(), path: `/api/v1${r.path.replace(/\{([^}]+)\}/g, ":$1")}` }));
}

function key(r: Registered): string {
  return `${r.method.toUpperCase()} ${r.path}`;
}

describe("API route contract membership", () => {
  it("every registered route is published or declared internal", { timeout: ROUTER_TREE_IMPORT_TIMEOUT_MS }, async () => {
    const { sessionsRouter } = await import("./routes/sessions.js");
    const { sessionLifecycleRouter } = await import("./routes/session-lifecycle.js");
    const { sessionViewRouter } = await import("./routes/session-view.js");
    const { sessionChangesRouter } = await import("./routes/session-changes.js");
    const { transcriptRouter } = await import("./routes/transcript.js");
    const { actionsRouter } = await import("./routes/actions.js");
    const { schedulesRouter } = await import("./routes/schedules.js");
    const { otlpRouter } = await import("./routes/otlp.js");
    const { webhooksRouter } = await import("./routes/webhooks.js");

    // Mount prefixes exactly as index.ts/app.ts give them.
    const sessionsRouters: Router[] = [sessionsRouter, transcriptRouter, sessionLifecycleRouter, sessionChangesRouter, sessionViewRouter];

    const raw: Registered[] = [
      ...sessionsRouters.flatMap((r) => rawRoutes(r, "/api/v1/sessions")),
      ...rawRoutes(actionsRouter, "/api/v1/actions"),
      ...rawRoutes(schedulesRouter, "/api/v1/schedules"),
      ...rawRoutes(otlpRouter, "/v1"),
      ...rawRoutes(webhooksRouter, "/webhooks"),
    ];

    const declared = new Set<string>([
      ...sessionsRouters.flatMap((r) => declaredRoutes(r, "/api/v1/sessions")).map(key),
      ...declaredRoutes(actionsRouter, "").map(key),
      ...declaredRoutes(schedulesRouter, "").map(key),
    ]);
    const internal = new Set(INTERNAL_ROUTES.map((r) => key({ method: r.method, path: r.path })));

    // Every raw route must be declared internal (raw routes are, by definition,
    // not in the OpenAPI contract — so the list is where they must appear).
    const undeclared = raw.filter((r) => !internal.has(key(r)) && !declared.has(key(r)));
    expect(undeclared.map(key), `raw routes missing from INTERNAL_ROUTES:\n${undeclared.map(key).join("\n")}`).toEqual([]);
  });

  it("every INTERNAL_ROUTES entry is actually registered (no stale entries)", { timeout: ROUTER_TREE_IMPORT_TIMEOUT_MS }, async () => {
    const { sessionsRouter } = await import("./routes/sessions.js");
    const { sessionLifecycleRouter } = await import("./routes/session-lifecycle.js");
    const { sessionViewRouter } = await import("./routes/session-view.js");
    const { actionsRouter } = await import("./routes/actions.js");
    const { schedulesRouter } = await import("./routes/schedules.js");
    const { otlpRouter } = await import("./routes/otlp.js");
    const { webhooksRouter } = await import("./routes/webhooks.js");
    const { promptsRouter } = await import("./routes/prompts.js");

    const prompts = promptsRouter({
      waitForPrompts: async () => [],
      getListeners: async () => ({}),
      registerListener: async () => {},
      unregisterListener: async () => {},
      checkWake: () => ({ allowed: true }),
      recordWake: async () => ({ allowed: true }),
    } as never);

    const registered = new Set<string>([
      ...rawRoutes(sessionsRouter, "/api/v1/sessions").map(key),
      ...rawRoutes(sessionLifecycleRouter, "/api/v1/sessions").map(key),
      ...rawRoutes(sessionViewRouter, "/api/v1/sessions").map(key),
      ...rawRoutes(actionsRouter, "/api/v1/actions").map(key),
      ...rawRoutes(schedulesRouter, "/api/v1/schedules").map(key),
      ...rawRoutes(prompts, "/api/v1/prompts").map(key),
      ...rawRoutes(otlpRouter, "/v1").map(key),
      ...rawRoutes(webhooksRouter, "/webhooks").map(key),
      // Registered inline on apiV1 in app.ts, not on a router.
      "POST /api/v1/identities/announce",
    ]);

    const stale = INTERNAL_ROUTES.filter((r) => !registered.has(key({ method: r.method, path: r.path })));
    expect(stale.map((r) => key({ method: r.method, path: r.path })), `INTERNAL_ROUTES entries not registered anywhere:\n${stale.map((r) => key({ method: r.method, path: r.path })).join("\n")}`).toEqual([]);
  });
});
