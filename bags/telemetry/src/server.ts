// Serve the metrics dashboard from its owning store without depending on session API availability.
// Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-128

import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, defaultDbPath, latest } from "./store.js";
import { scheduleOverview } from "./schedules.js";
import { serviceSummaries, hostSummary, firingAlerts, series } from "./summary.js";
import { DEFAULT_RULES } from "./rules.js";
import { registry } from "./framework/telemetry.js";
import { PAGES, withNav, withPanels } from "./framework/pages.js";
import { fetchPanel, renderPanelShells } from "./framework/contributed-panels.js";
import { loadPanelContributions } from "./framework/contributions.js";
import { usageOverview, toolIntelligence, healthReport, costReport } from "./usage/summary-usage.js";
import {
  openRequestsDb, requestVolume, routeLatency, statusMix, serviceMix,
  coverage as requestCoverage,
} from "./usage/requests.js";
import { barryAppSupportDir, assignedPort, listenOnAssignedPort, getServiceUrl, instanceEnvValue } from "@barry-rocks/sdk/services";

import { handleSignIn, isAuthorized, SIGN_IN_PATH } from "@barry-rocks/sdk/auth";

import { parseLabelsParam } from "./series-labels.js";

import { Barry } from "@barry-rocks/sdk";



// A missing API leaves only the schedules page unavailable; telemetry still starts.
let schedulesUnavailable: string | undefined;
try {
  Barry.connect({ baseUrl: getServiceUrl("api"), secret: instanceEnvValue("BARRY_SECRET") });
} catch (error) {
  schedulesUnavailable = error instanceof Error ? error.message : String(error);
}

const HERE = dirname(fileURLToPath(import.meta.url));
// Assigned by the supervisor; no fallback, because a guessed port is how a
// second copy of a service ends up answering for the first.
const PORT = assignedPort();

// Serve only explicitly cataloged assets rather than joining arbitrary request paths.
// Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-129
const STATIC_ASSETS: Record<string, { file: string; type: string }> = {
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/spark.js": { file: "spark.js", type: "text/javascript; charset=utf-8" },
  "/catalog.js": { file: "catalog.js", type: "text/javascript; charset=utf-8" },
  "/jobs.js": { file: "jobs.js", type: "text/javascript; charset=utf-8" },
  "/panels.js": { file: "panels.js", type: "text/javascript; charset=utf-8" },
};

// Reopen SQLite after database replacement so a long-running server does not retain the old inode.
// Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-130
let db = openDb();
let dbInode = currentInode();

// Read contributions once at boot so request handling does not repeatedly scan manifests.
// Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-131
const PANELS = loadPanelContributions();

// Resolve contributor addresses through installed service identity, without assuming a fixed port.
// Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-132
function resolvePanelBase(bag: string, resource: string): string {
  // Read the registry file directly rather than importing `getBagResourceUrl`
  // from `@barry-rocks/sdk/tools`.
  //
  // That import would mean a cross-repo `link:` dependency, and this bag has
  // refused that more than once in writing -- `collect-ollama.ts` restates
  // a few lines instead, on the grounds that the coupling is
  // heavier than the code it saves. It is also the diagnosis for why
  // `@barry-rocks/job-telemetry` and `usage-telemetry` have one adopter between
  // them: a shared package nobody can depend on cheaply is a package nobody
  // depends on.
  //
  // There is a second cost, found while verifying this branch: a `link:` path
  // is relative, so it cannot resolve from a detached worktree. The bag becomes
  // impossible to typecheck outside its own directory -- which is exactly how
  // a reviewer runs it.
  //
  // The file is a versioned, two-key JSON document (`{version, resources}`)
  // keyed `<bag>.<name>`, and entries carry `url` rather than a port precisely
  // so containers and remote deployments share one shape. Reading it is the
  // contract; the helper is a convenience over the same bytes.
  const path =
    process.env.BARRY_BAG_RESOURCES ||
    join(barryAppSupportDir(), "bag-resources.json");

  let file: { resources?: Record<string, { url?: string }> };
  try {
    file = JSON.parse(readFileSync(path, "utf8")) as typeof file;
  } catch {
    // No registry yet, or unreadable. A contributor that cannot be located is
    // reported as unavailable by the caller, never rendered as empty.
    throw new Error(`bag resource registry unreadable at ${path}`);
  }

  const url = file.resources?.[`${bag}.${resource}`]?.url;
  if (!url) throw new Error(`no registered resource "${bag}.${resource}"`);
  return url;
}

function currentInode(): number | null {
  try {
    return statSync(defaultDbPath()).ino;
  } catch {
    return null;
  }
}

function liveDb() {
  const ino = currentInode();
  if (ino !== null && ino !== dbInode) {
    try {
      db.close();
    } catch {
      // Already closed or mid-failure; the reopen below is what matters.
    }
    db = openDb();
    dbInode = ino;
    process.stdout.write("metrics db was replaced on disk; reopened\n");
  }
  return db;
}

function json(res: import("node:http").ServerResponse, body: unknown, status = 200) {
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload)),
    // The dashboard polls; caching a snapshot would show stale state.
    "cache-control": "no-store",
  };
  // The cached usage/tools/reliability reports carry their own staleMs field
  // (see report-cache.ts): surface it as a header too, so a client — or a
  // curl during an incident — can tell "just rebuilt" from "served from the
  // 30s cache" without parsing the body.
  if (body && typeof body === "object" && "staleMs" in body && typeof (body).staleMs === "number") {
    headers["x-report-stale-ms"] = String((body as { staleMs: number }).staleMs);
  }
  res.writeHead(status, headers);
  res.end(payload);
}

/**
 * Exported so the route tests can drive the real server rather than a
 * reimplementation of it. A test that asserts against a second copy of the
 * routing table proves only that the copy agrees with itself.
 */
export const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

  try {
    if (url.pathname === "/health") {
      return json(res, { ok: true, service: "barry-metrics" });
    }

    const asset = STATIC_ASSETS[url.pathname];
    if (asset) {
      const body = readFileSync(join(HERE, "..", "web", asset.file), "utf8");
      res.writeHead(200, { "content-type": asset.type });
      return res.end(body);
    }

    // Read per request, so a test can set it after importing this module.
    const secret = process.env.BARRY_SECRET ?? "";
    if (!secret) {
      return json(res, { error: "the metrics dashboard has no BARRY_SECRET, so it refuses every request" }, 500);
    }
    if (url.pathname === SIGN_IN_PATH) {
      handleSignIn(req, res, secret, "Metrics").catch((err) => json(res, { error: String(err) }, 500));
      return;
    }
    if (!isAuthorized(req, secret)) {
      if (url.pathname.startsWith("/api/")) return json(res, { error: "unauthorized", signIn: SIGN_IN_PATH }, 401);
      // A page: send the browser to sign in, which sends it back to /.
      res.writeHead(303, { location: SIGN_IN_PATH, "cache-control": "no-store" });
      return res.end();
    }

    if (url.pathname === "/api/overview") {
      const handle = liveDb();
      return json(res, {
        services: serviceSummaries(handle),
        host: hostSummary(handle),
        alerts: firingAlerts(handle),
        rules: [...DEFAULT_RULES, ...registry.rules()].map((r) => ({
          id: r.id,
          severity: r.severity,
          rationale: r.rationale,
        })),
      });
    }

    // Batch series reads while retaining each metric’s label identity.
    // Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-133
    if (url.pathname === "/api/sparklines") {
      const sinceSec = Number(url.searchParams.get("since") ?? 6 * 3600);
      const handle = liveDb();
      const wanted = (url.searchParams.get("metrics") ?? "").split(",").filter(Boolean);
      const out: Record<string, Array<{ ts: number; value: number }>> = {};
      for (const metric of wanted.slice(0, 12)) {
        // Sparklines are ~120px wide; more points than that is invisible detail
        // at real cost over the wire.
        out[metric] = series(handle, metric, sinceSec, undefined, 60);
      }
      return json(res, { sinceSec, series: out });
    }

    // Expose the metric catalog alongside readings so absent series remain discoverable.
    // Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-134
    if (url.pathname === "/api/catalog") {
      const handle = liveDb();
      // Same source as the `metrics catalog` tool -- the registry, holding the
      // built-ins plus any contribution -- so the page and the tool still
      // cannot disagree about which metrics exist.
      const declared = registry.metrics();
      return json(res, {
        total: declared.length,
        metrics: declared.map((m) => {
          const rows = latest(handle, m.name);
          return {
            name: m.name,
            unit: m.unit,
            description: m.description,
            // A declared metric with no rows is a distinct state from a zero
            // value, and the page renders it as such.
            collected: rows.length > 0,
            series: rows.map((r) => ({ labels: r.labels, value: r.value, ts: r.ts })),
          };
        }),
      });
    }

    /**
     * Schedules: health of the scheduler, then each schedule's state and its
     * recent runs. Read through the sessions API.
     */
    if (url.pathname === "/api/schedules") {
      if (schedulesUnavailable) return json(res, { state: "unavailable", reason: schedulesUnavailable, schedules: [] });
      return scheduleOverview().then(
        (body) => json(res, body),
        // "Cannot read the schedule stores" must not render as "no schedules".
        (err: unknown) => json(res, { state: "unavailable", reason: String(err), schedules: [] }),
      );
    }

    if (url.pathname === "/api/series") {
      const metric = url.searchParams.get("metric");
      if (!metric) return json(res, { error: "metric required" }, 400);
      const sinceSec = Number(url.searchParams.get("since") ?? 6 * 3600);
      const parsedLabels = parseLabelsParam(url.searchParams.get("labels"));
      if (!parsedLabels.ok) return json(res, { error: parsedLabels.error }, 400);
      return json(res, { metric, points: series(liveDb(), metric, sinceSec, parsedLabels.labels) });
    }

    // An explicit asset allowlist prevents traversal and accidental source-file exposure.
    // Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-135
    // Usage panels are asynchronous because their read models query other owning stores.
    // Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-136
    if (url.pathname === "/api/usage/overview") {
      const requested = Number(url.searchParams.get("days") ?? 30);
      const days = Number.isFinite(requested) ? Math.min(365, Math.max(1, requested)) : 30;
      return usageOverview(days).then(
        (body) => json(res, body),
        (err) => {
          // Only reachable if the read model itself throws, which would be a bug
          // rather than a data-source failure — surface it instead of an empty page.
          process.stderr.write(`usage overview failed: ${String(err)}\n`);
          json(res, { error: String(err) }, 500);
        },
      );
    }

    if (url.pathname === "/api/usage/tools") {
      const requested = Number(url.searchParams.get("days") ?? 30);
      const days = Number.isFinite(requested) ? Math.min(365, Math.max(1, requested)) : 30;
      return toolIntelligence(days).then(
        (body) => json(res, body),
        (err) => {
          process.stderr.write(`tool intelligence failed: ${String(err)}\n`);
          json(res, { error: String(err) }, 500);
        },
      );
    }

    if (url.pathname === "/api/usage/health") {
      const requested = Number(url.searchParams.get("days") ?? 30);
      const days = Number.isFinite(requested) ? Math.min(365, Math.max(1, requested)) : 30;
      return healthReport(days).then(
        (body) => json(res, body),
        (err) => {
          process.stderr.write(`health report failed: ${String(err)}\n`);
          json(res, { error: String(err) }, 500);
        },
      );
    }

    if (url.pathname === "/api/usage/cost") {
      const requested = Number(url.searchParams.get("days") ?? 30);
      const days = Number.isFinite(requested) ? Math.min(365, Math.max(1, requested)) : 30;
      // Synchronous: this reads local SQLite, unlike the async panels above.
      return json(res, costReport(days));
    }

    if (url.pathname === "/api/usage/requests") {
      const requested = Number(url.searchParams.get("days") ?? 30);
      const days = Number.isFinite(requested) ? Math.min(400, Math.max(1, requested)) : 30;
      const since = Math.floor(Date.now() / 1000) - days * 86400;
      // Hourly for short windows, daily beyond — a 90-day hourly chart is 2,160
      // points the browser would immediately throw away.
      const bucket = days <= 2 ? 3600 : 86400;
      const rdb = openRequestsDb();
      try {
        return json(res, {
          windowDays: days,
          generatedAt: Date.now(),
          coverage: requestCoverage(rdb),
          volume: requestVolume(rdb, since, bucket),
          routes: routeLatency(rdb, since),
          statuses: statusMix(rdb, since),
          services: serviceMix(rdb, since),
        });
      } finally {
        rdb.close();
      }
    }


    // Proxy contributor data with bounded failures so a missing bag does not break the host page.
    // Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-137
    if (url.pathname.startsWith("/api/panels/")) {
      const key = decodeURIComponent(url.pathname.slice("/api/panels/".length));
      const panel = PANELS.get(key);
      if (!panel) {
        return json(res, {
          state: "unavailable",
          reason: `No panel "${key}" is registered. It may have been contributed by a bag that is no longer enabled.`,
        }, 404);
      }
      return fetchPanel(panel, resolvePanelBase).then((body) => json(res, body));
    }

    // Every page, from one list. Previously eight near-identical blocks plus a
    // ninth for "/", each naming its own file — so a new page meant a new block
    // here AND a nav edit in all nine HTML files.
    //
    // `file` comes from PAGES and never from the request path: a
    // `join(HERE, "..", "web", url.pathname)` would be directory traversal, and
    // not reachable today is not a security boundary.
    const page = PAGES.find(
      (p) => url.pathname === p.path || url.pathname === `/${p.file}`,
    );
    if (page) {
      // Read per request rather than cached at boot: editing the page during
      // development should not need a service restart.
      const html = readFileSync(join(HERE, "..", "web", page.file), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      // Contributed panels are appended to the page, and the script that fills
      // them is only loaded when there is at least one — a page with no
      // contributions renders byte-for-byte what it rendered before this
      // existed, which is what makes the mechanism safe to add to nine live
      // pages at once.
      const shells = renderPanelShells(PANELS.forPage(page.path));
      const body = withPanels(withNav(html, page.path), shells);
      return res.end(
        shells ? body.replace("</body>", '<script type="module" src="/panels.js"></script>\n</body>') : body,
      );
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  } catch (err) {
    // A failed read must return an error the dashboard can show, not kill the
    // process — this service exists to be up when other things are down.
    process.stderr.write(`request ${url.pathname} failed: ${String(err)}\n`);
    json(res, { error: String(err) }, 500);
  }
});

await listenOnAssignedPort(server);
process.stdout.write(`barry-metrics listening on http://127.0.0.1:${PORT}\n`);
