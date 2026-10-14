// Contributions extend the host dashboard through descriptors, without importing another bag’s implementation.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-040

import type { Panel } from "./panel.js";

// A contributed panel declares its data contract and location without owning the host page.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-041
export interface PanelContribution {
  /** The contributing bag, as registered in the resource registry. */
  bag: string;
  /** The bag's resource name, e.g. "web". Resolved to a base URL at fetch time. */
  resource: string;
  // Restrict stable panel IDs to a safe alphabet for DOM and URL use.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-028
  id: string;
  /** Shown as the panel heading. Untrusted: escaped everywhere it reaches HTML. */
  title: string;
  /** Path on the contributor's own service returning a `Panel<Row[]>` JSON body. */
  dataPath: string;
  /** Which host page this panel appears on. Must be an existing `PAGES` path. */
  page: string;
  /** Column headers, left to right. Untrusted, escaped. */
  columns: string[];
  /** Milliseconds before the fetch is abandoned as unavailable. */
  timeoutMs?: number;
}

/** A contributed row: one string per declared column. */
export type PanelRow = string[];

// Validate identifiers and escape display text; those are different trust boundaries.
// Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-029
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A contributor's path must stay on the contributor's own service. */
function safeDataPath(p: string): boolean {
  // Must be a rooted path with no scheme and no authority: "//evil.example"
  // parses as an authority in a URL join and would send the host's fetch
  // somewhere the resource registry never named.
  return p.startsWith("/") && !p.startsWith("//") && !p.includes("..");
}

export interface RegisteredPanel extends PanelContribution {
  /** `<bag>.<id>` — unique across the dashboard. */
  key: string;
}

// Panel keys include their owner; reject collisions rather than silently replacing a contribution.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-042
export class PanelRegistry {
  private readonly byKey = new Map<string, RegisteredPanel>();

  /** Register one panel. Throws on a collision or a malformed descriptor. */
  register(c: PanelContribution): RegisteredPanel {
    // Shape first, because everything below assumes these fields EXIST.
    //
    // The checks that follow read `c.title.trim()` and `c.columns.length`, which
    // is safe when the descriptor was built in TypeScript and the compiler
    // enforced the type. It is not safe here: contributions arrive as JSON from
    // another bag's file on disk, where nothing checks the shape.
    //
    // A declaration missing `columns` therefore threw
    // `Cannot read properties of undefined (reading 'length')` — a message that
    // names neither the panel, the bag, nor the field. The loader caught it,
    // wrote it to stderr, and moved on, so the panel simply never appeared. That
    // cost ten minutes of reading the wrong code, twice: once for a missing
    // `page` and once for a missing `columns`.
    //
    // Naming the field turns "something is broken somewhere" into a fix.
    for (const field of ["bag", "resource", "id", "title", "dataPath", "page"] as const) {
      if (typeof c?.[field] !== "string") {
        throw new Error(
          `panel declaration is missing a string "${field}" ` +
            `(got ${JSON.stringify(c?.[field])}) — declared by bag ${JSON.stringify(c?.bag ?? "unknown")}`,
        );
      }
    }
    if (!Array.isArray(c.columns)) {
      throw new Error(
        `panel "${c.bag}.${c.id}" is missing "columns" (got ${JSON.stringify(c.columns)}); ` +
          `it must be an array of header strings, one per value in each row`,
      );
    }
    if (c.columns.some((h) => typeof h !== "string")) {
      throw new Error(`panel "${c.bag}.${c.id}" has a non-string column header`);
    }

    if (!SAFE_ID.test(c.id)) {
      throw new Error(
        `panel id ${JSON.stringify(c.id)} from "${c.bag}" is not a safe id ` +
          `(lowercase letters, digits and dashes) — it becomes a DOM id and a URL path`,
      );
    }
    if (!SAFE_ID.test(c.bag)) {
      throw new Error(`bag name ${JSON.stringify(c.bag)} is not a safe id`);
    }
    if (!safeDataPath(c.dataPath)) {
      throw new Error(
        `panel "${c.bag}.${c.id}" declares dataPath ${JSON.stringify(c.dataPath)}; ` +
          `it must be a rooted path on the bag's own service, so the host cannot ` +
          `be pointed at another origin`,
      );
    }
    if (!c.title.trim()) throw new Error(`panel "${c.bag}.${c.id}" has no title`);
    if (c.columns.length === 0) throw new Error(`panel "${c.bag}.${c.id}" declares no columns`);

    const key = `${c.bag}.${c.id}`;
    const held = this.byKey.get(key);
    if (held) {
      throw new Error(`panel "${key}" already registered; "${c.bag}" cannot claim it twice`);
    }
    const registered: RegisteredPanel = { ...c, key };
    this.byKey.set(key, registered);
    return registered;
  }

  /** Every panel, registration order. */
  all(): RegisteredPanel[] {
    return [...this.byKey.values()];
  }

  /** Panels for one host page, in registration order. */
  forPage(path: string): RegisteredPanel[] {
    return this.all().filter((p) => p.page === path);
  }

  get(key: string): RegisteredPanel | undefined {
    return this.byKey.get(key);
  }
}

/** How the host resolves a bag's base URL. Injected so tests need no registry file. */
export type ResolveBase = (bag: string, resource: string) => string;

// Validate panel response shape before rendering untrusted data.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-043
function validate(body: unknown): Panel<PanelRow[]> | { bad: string } {
  if (!body || typeof body !== "object") return { bad: "body is not an object" };
  const state = (body as { state?: unknown }).state;
  if (state === "unavailable") {
    const reason = (body as { reason?: unknown }).reason;
    return typeof reason === "string"
      ? { state: "unavailable", reason }
      : { bad: "unavailable without a reason" };
  }
  if (state === "empty") {
    const explanation = (body as { explanation?: unknown }).explanation;
    return typeof explanation === "string"
      ? { state: "empty", explanation }
      : { bad: "empty without an explanation" };
  }
  if (state === "ok" || state === "partial") {
    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data) || !data.every((r) => Array.isArray(r) && r.every((c) => typeof c === "string"))) {
      return { bad: `${state} body's data is not an array of string arrays` };
    }
    const ms = Number((body as { ms?: unknown }).ms ?? 0);
    if (state === "ok") return { state: "ok", data: data, ms };
    const caveat = (body as { caveat?: unknown }).caveat;
    return typeof caveat === "string"
      ? { state: "partial", data: data, caveat, ms }
      : { bad: "partial without a caveat" };
  }
  return { bad: `unknown panel state ${JSON.stringify(state)}` };
}

const DEFAULT_TIMEOUT_MS = 2500;

// A contributed fetch returns a typed unavailable result instead of rejecting the host page.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-044
export async function fetchPanel(
  panel: RegisteredPanel,
  resolveBase: ResolveBase,
  fetchImpl: typeof fetch = fetch,
): Promise<Panel<PanelRow[]>> {
  const started = Date.now();
  const where = `${panel.bag}.${panel.resource}`;

  let base: string;
  try {
    base = resolveBase(panel.bag, panel.resource);
  } catch (err) {
    return {
      state: "unavailable",
      reason: `${where} is not in the bag resource registry (${String(err)}). The bag may be disabled, or its launchd setup not run.`,
    };
  }

  let url: string;
  try {
    // `new URL(path, base)` with a rooted path keeps the base's origin, and
    // `safeDataPath` already refused the "//host" form that would not.
    url = new URL(panel.dataPath, base).toString();
  } catch {
    return { state: "unavailable", reason: `${where} registered an unusable base URL ${JSON.stringify(base)}.` };
  }

  const timeoutMs = panel.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const control = new AbortController();
  // A contributor that accepts the connection and then never answers would
  // otherwise hold this page open forever. A slow contributor costs itself.
  const timer = setTimeout(() => control.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, { signal: control.signal, headers: { accept: "application/json" } });
    if (!res.ok) {
      return { state: "unavailable", reason: `${where} answered HTTP ${res.status} at ${panel.dataPath}.` };
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        state: "unavailable",
        reason: `${where} answered ${panel.dataPath} with ${res.headers.get("content-type") ?? "no content-type"} that is not JSON.`,
      };
    }
    const checked = validate(parsed);
    if ("bad" in checked) {
      return { state: "unavailable", reason: `${where} returned a malformed panel: ${checked.bad}.` };
    }
    // The contributor's own self-reported timing is not trusted over the wall
    // clock the host measured; a panel that claims 0ms while taking 2s hides
    // exactly the slowness worth seeing.
    if (checked.state === "ok" || checked.state === "partial") {
      return { ...checked, ms: Date.now() - started };
    }
    return checked;
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      state: "unavailable",
      reason: aborted
        ? `${where} did not answer ${panel.dataPath} within ${timeoutMs}ms.`
        : `${where} is unreachable at ${base} (${err instanceof Error ? err.message : String(err)}). Is the service running?`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Escape every contributed title and cell because both are untrusted input.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-045
function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

// Render an empty panel shell before fetching so a missing contributor cannot block the page.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-046
export function renderPanelShell(panel: RegisteredPanel): string {
  const heads = panel.columns.map((c) => `<th>${esc(c)}</th>`).join("");
  return [
    `  <section class="contributed" data-panel="${esc(panel.key)}">`,
    `    <h2>${esc(panel.title)} <span class="from">${esc(panel.bag)}</span></h2>`,
    `    <div class="panel scroll" id="panel-${esc(panel.key)}">`,
    `      <div class="empty">loading ${esc(panel.title)} from ${esc(panel.bag)}…</div>`,
    `    </div>`,
    `    <template data-cols>${heads}</template>`,
    `  </section>`,
  ].join("\n");
}

/** Every contributed panel's shell for one page, or "" when there are none. */
export function renderPanelShells(panels: RegisteredPanel[]): string {
  if (panels.length === 0) return "";
  return "\n" + panels.map(renderPanelShell).join("\n") + "\n";
}
