// Render contributed panels inside host-provided shells and preserve unavailable responses.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-241

import { $, esc, schedulePolling } from "/spark.js";

/** Every shell the server rendered on this page. */
function shells() {
  return [...document.querySelectorAll("section.contributed[data-panel]")];
}

function renderInto(el, cols, panel) {
  if (!panel) {
    el.innerHTML = '<div class="down"><b>✖ no response</b> — the dashboard returned no panel.</div>';
    return;
  }
  if (panel.state === "unavailable") {
    el.innerHTML = `<div class="down"><b>✖ unavailable</b> — ${esc(panel.reason)}</div>`;
    return;
  }
  if (panel.state === "empty") {
    el.innerHTML = `<div class="empty">${esc(panel.explanation)}</div>`;
    return;
  }
  const caveat = panel.state === "partial" ? `<div class="caveat">⚠ ${esc(panel.caveat)}</div>` : "";
  const rows = (panel.data || [])
    .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`)
    .join("");
  // `cols` came from the server's own <template>, which the server built by
  // escaping the contributor's column text — so it is markup this page made,
  // not markup a contributor supplied.
  el.innerHTML = `${caveat}<table><thead><tr>${cols}</tr></thead><tbody>${rows}</tbody></table>`;
}

async function refresh() {
  await Promise.all(
    shells().map(async (section) => {
      const key = section.dataset.panel;
      const el = $(`panel-${key}`);
      const cols = section.querySelector("template[data-cols]")?.innerHTML ?? "";
      try {
        const res = await fetch(`/api/panels/${encodeURIComponent(key)}`);
        renderInto(el, cols, await res.json());
      } catch (err) {
        // The host itself is unreachable — distinct from the contributor being
        // down, and said so rather than blamed on the contributor.
        el.innerHTML = `<div class="down"><b>✖ dashboard unreachable</b> — ${esc(String(err))}</div>`;
      }
    }),
  );
}

if (shells().length > 0) schedulePolling(refresh, 15000);
