// Declare pages centrally so navigation and routes agree.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-055

export interface Page {
  /** URL path, leading slash. `/x` also answers at `/x.html`. */
  path: string;
  /** Text in the nav. */
  label: string;
  /** Filename under `web/`. */
  file: string;
  // Persist the time window in navigation so reloads and shared URLs retain it.
  // Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-056
  windows?: boolean;
}

// Keep incident infrastructure first in navigation and metric discovery last.
// Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-039
export const PAGES: Page[] = [
  { path: "/", label: "Infrastructure", file: "index.html" },
  { path: "/usage", label: "Usage", file: "usage.html", windows: true },
  { path: "/tools", label: "Tools", file: "tools.html", windows: true },
  { path: "/reliability", label: "Reliability", file: "reliability.html", windows: true },
  { path: "/cost", label: "Cost", file: "cost.html", windows: true },
  { path: "/requests", label: "Requests", file: "requests.html", windows: true },
  { path: "/schedules", label: "Schedules", file: "schedules.html" },
  { path: "/metrics", label: "Metrics", file: "metrics.html", windows: true },
];

/** Escape text destined for HTML. Labels are ours today, contributed tomorrow. */
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

// Mark the active link with aria-current for both styling and screen readers.
// Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-040
export function renderNav(activePath: string): string {
  const links = PAGES.map((p) => {
    const current = p.path === activePath ? ' aria-current="page"' : "";
    return `    <a href="${p.path}"${current}>${esc(p.label)}</a>`;
  }).join("\n");

  const active = PAGES.find((p) => p.path === activePath);
  const windows = active?.windows
    ? '    <div class="windows" id="windows" role="group" aria-label="Time window"></div>\n'
    : "";

  return `<nav>\n${windows}${links}\n  </nav>`;
}

/** Marker a page's HTML carries in place of its nav. */
export const NAV_PLACEHOLDER = "<!--nav-->";

// A page without the navigation marker remains usable instead of failing over a missing comment.
// Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-041
export function withNav(html: string, activePath: string): string {
  return html.includes(NAV_PLACEHOLDER)
    ? html.replace(NAV_PLACEHOLDER, renderNav(activePath))
    : html;
}

// Contributed panels occupy declared host slots rather than arbitrary HTML locations.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-057
export const PANELS_PLACEHOLDER = "<!--panels-->";

// Substitute contribution markers without allowing a contributor to rewrite the host document.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-058
export function withPanels(html: string, panelsHtml: string): string {
  if (!panelsHtml) return html;
  if (html.includes(PANELS_PLACEHOLDER)) return html.replace(PANELS_PLACEHOLDER, panelsHtml);
  const close = html.lastIndexOf("</main>");
  if (close === -1) return html;
  return html.slice(0, close) + panelsHtml + html.slice(close);
}

/** Escape contributed text destined for HTML. Exported for the panel renderer. */
export const escapeHtml = esc;
