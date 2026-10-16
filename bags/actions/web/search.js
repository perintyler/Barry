/**
 * Catalog search — the one piece of real logic in the UI, kept in its own
 * module so it can be tested without a DOM.
 *
 * Rank by WHERE the match lands. An action whose name starts with the query is
 * what you meant; one that merely mentions it somewhere in a paragraph of
 * description is a long shot. Without the split, typing "commit" buried
 * `commit-all` under every action whose description happens to say "commit".
 */
export function rankActions(catalog, query, limit = 40) {
  const q = query.trim().toLowerCase();
  // An empty box is not "no matches" — it is "you have not chosen yet", so
  // show a browsable handful rather than all 122 or none.
  if (!q) return catalog.slice(0, 12);

  const scored = [];
  for (const a of catalog) {
    const name = (a.name || "").toLowerCase();
    let score = -1;
    if (name.startsWith(q)) score = 0;
    else if (name.includes(q)) score = 1;
    else if ((a.bag || "").toLowerCase().includes(q)) score = 2;
    else if ((a.description || "").toLowerCase().includes(q)) score = 3;
    if (score >= 0) scored.push({ a, score });
  }
  scored.sort((x, y) => x.score - y.score || x.a.name.localeCompare(y.a.name));
  return scored.slice(0, limit).map((s) => s.a);
}

/**
 * Read a form into the `inputs` object the API expects.
 *
 * Only fields the user actually filled are included. An untouched field is
 * OMITTED rather than sent as its default, because the API reads an omitted
 * field as "open, infer it" and a present one as "the human decided this" —
 * sending defaults would silently suppress the inference the action asked for.
 */
export function coerceInputs(entries) {
  const inputs = {};
  for (const { field, kind, value } of entries) {
    const raw = (value ?? "").trim();
    if (!raw) continue;
    if (kind === "number" || kind === "integer") {
      const n = Number(raw);
      if (!Number.isNaN(n)) inputs[field] = n;
    } else if (kind === "boolean") {
      inputs[field] = raw === "true";
    } else {
      inputs[field] = raw;
    }
  }
  return inputs;
}

const STATE_LABELS = {
  "needs-attention": "Needs attention",
  "waiting-for-approval": "Waiting for approval",
  stopping: "Stopping",
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  completed: "Completed",
  cancelled: "Cancelled",
  failed: "Failed",
  complete: "Complete",
  started: "Started",
};

export function formatLegacyRunState(run) {
  const hasFailedChecks = Array.isArray(run?.validation_failures) && run.validation_failures.length > 0;
  if ((run?.workflow?.state === "completed" || run?.status === "complete") && (run?.status === "failed" || hasFailedChecks)) {
    return "Completed; checks failed";
  }
  const state = run?.workflow?.state ?? run?.status ?? "unknown";
  return STATE_LABELS[state] ?? state;
}

export function formatIdentityWorkState(work, result) {
  const checksFailed = Boolean(
    result && (
      Object.values(result.action_checks || {}).some(check => check && !check.unknown && !check.passed)
      || result.retained_output?.validation === "failed"
      || (Array.isArray(result.retained_output?.validation_failures) && result.retained_output.validation_failures.length > 0)
    ),
  );
  if (work?.state === "completed" && checksFailed) {
    return "Completed; checks failed";
  }
  const raw = work?.state;
  if (!raw) return "Unknown";
  return STATE_LABELS[raw] || raw.replace(/^./, c => c.toUpperCase());
}

export function describeIdentityWorkSituation(work, nowMs = Date.now()) {
  if (!work) return "";
  const phase = work.facts?.phase ?? "queued";
  const physical = work.facts?.physical ?? "not-started";
  const effect = work.facts?.effect ?? "not-started";
  const wait = work.facts?.wait && work.facts.wait !== "none" ? work.facts.wait : null;
  const acceptedMs = typeof work.accepted_at === "number" ? work.accepted_at : Date.parse(work.accepted_at ?? "");
  const startedMs = typeof work.first_started_at === "number" ? work.first_started_at : Date.parse(work.first_started_at ?? "");
  const parts = [`Phase: ${phase}`, `Physical: ${physical}`, `Effects: ${effect}`];
  if (wait) parts.push(`Wait: ${wait} (no execution slot held)`);
  if (Number.isFinite(startedMs)) {
    const execSec = Math.max(0, Math.floor((nowMs - startedMs) / 1000));
    parts.push(`Elapsed since start: ${execSec}s`);
  } else if (Number.isFinite(acceptedMs)) {
    const queueSec = Math.max(0, Math.floor((nowMs - acceptedMs) / 1000));
    parts.push(`In queue: ${queueSec}s`);
  }
  if (work.facts?.stop_requested && work.state !== "cancelled") {
    parts.push("Stop requested (awaiting physical cessation)");
  }
  return parts.join(" · ");
}

export function validateIdentityStartInputs(task, fieldEntries, rawJsonOverride = "") {
  const trimmedOverride = typeof rawJsonOverride === "string" ? rawJsonOverride.trim() : "";
  if (trimmedOverride) {
    try {
      const value = JSON.parse(trimmedOverride);
      if (!value || Array.isArray(value) || typeof value !== "object") {
        return { ok: false, inputs: {}, fieldErrors: {}, message: "Inputs must be a JSON object." };
      }
      return { ok: true, inputs: value, fieldErrors: {}, message: null };
    } catch (error) {
      return { ok: false, inputs: {}, fieldErrors: {}, message: error instanceof Error ? error.message : "Inputs must be valid JSON." };
    }
  }
  const required = new Set(task?.input_schema?.required || []);
  const props = task?.input_schema?.properties || {};
  const inputs = {};
  const fieldErrors = {};

  for (const entry of fieldEntries) {
    const { name, value, isJson, type } = entry;
    const spec = props[name] || {};
    const label = spec.title || name;
    const raw = value === undefined || value === null ? "" : String(value);
    if (raw === "") {
      if (required.has(name)) {
        fieldErrors[name] = `${label} is required.`;
      }
      continue;
    }
    if (isJson) {
      try {
        inputs[name] = JSON.parse(raw);
      } catch {
        fieldErrors[name] = `${label} must be valid JSON.`;
      }
      continue;
    }
    if (type === "number" || type === "integer") {
      const num = Number(raw);
      if (!Number.isFinite(num)) {
        fieldErrors[name] = `${label} must be a valid number.`;
        continue;
      }
      if (type === "integer" && !Number.isInteger(num)) {
        fieldErrors[name] = `${label} must be an integer.`;
        continue;
      }
      if (typeof spec.minimum === "number" && num < spec.minimum) {
        fieldErrors[name] = `${label} must be at least ${spec.minimum}.`;
        continue;
      }
      if (typeof spec.maximum === "number" && num > spec.maximum) {
        fieldErrors[name] = `${label} must be at most ${spec.maximum}.`;
        continue;
      }
      inputs[name] = num;
      continue;
    }
    inputs[name] = raw;
  }

  const firstError = Object.values(fieldErrors)[0] || null;
  return {
    ok: !firstError,
    inputs,
    fieldErrors,
    message: firstError,
  };
}

