// Expose metric discovery and label dimensions without requiring a preselected series.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-238

// No `esc` import: every value here reaches the DOM through textContent, which
// cannot interpret markup, rather than through an HTML string.
import { $, drawSpark } from "/spark.js";

const WINDOWS = [
  { label: "6h", sec: 6 * 3600 },
  { label: "24h", sec: 24 * 3600 },
  { label: "7d", sec: 7 * 86400 },
  { label: "30d", sec: 30 * 86400 },
];

// Persist catalog state in the URL so reloads and shared links keep their filters.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-239
const params = new URLSearchParams(location.search);
let selected = params.get("metric") || null;
let labelKey = params.get("labels") || null;
let sinceSec = Number(params.get("since")) || 6 * 3600;
if (!WINDOWS.some((w) => w.sec === sinceSec)) sinceSec = 6 * 3600;

let catalog = [];
let query = "";

function syncUrl() {
  const p = new URLSearchParams();
  if (selected) p.set("metric", selected);
  if (sinceSec !== 6 * 3600) p.set("since", String(sinceSec));
  if (labelKey) p.set("labels", labelKey);
  const qs = p.toString();
  history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
}

/** Group by the second segment of the dotted name: barry.<group>.<rest>. */
function groupOf(name) {
  const parts = name.split(".");
  return parts.length > 2 ? parts[1] : "other";
}

const NUM = new Intl.NumberFormat([], { maximumFractionDigits: 2 });
function fmtValue(v, unit) {
  if (unit === "bool") return v ? "yes" : "no";
  return `${NUM.format(v)}${unit === "%" ? "%" : ""}`;
}

/** "{"service":"api"}" -> "service=api"; the empty label set reads as "all". */
function labelText(labels) {
  const keys = Object.keys(labels || {});
  if (keys.length === 0) return "all";
  return keys.map((k) => `${k}=${labels[k]}`).join(" ");
}

function matches(m) {
  if (!query) return true;
  const q = query.toLowerCase();
  return m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q);
}

function render() {
  const host = $("catalog");
  host.textContent = "";

  const shown = catalog.filter(matches);
  $("count").textContent =
    shown.length === catalog.length
      ? `${catalog.length} metrics`
      : `${shown.length} of ${catalog.length} metrics`;

  if (shown.length === 0) {
    const none = document.createElement("div");
    none.className = "empty";
    none.textContent = `No metric matches “${query}”.`;
    host.appendChild(none);
    return;
  }

  const groups = new Map();
  for (const m of shown) {
    const g = groupOf(m.name);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(m);
  }

  for (const [name, metrics] of groups) {
    const section = document.createElement("div");
    section.className = "group";
    const h = document.createElement("h3");
    h.textContent = name;
    section.appendChild(h);

    for (const m of metrics) {
      section.appendChild(rowFor(m));
      if (m.name === selected) section.appendChild(detailFor(m));
    }
    host.appendChild(section);
  }
}

function rowFor(m) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "row";
  row.setAttribute("aria-expanded", String(m.name === selected));

  const name = document.createElement("span");
  name.className = "mname";
  name.textContent = m.name;
  const unit = document.createElement("span");
  unit.className = "unit";
  unit.textContent = m.unit;
  name.appendChild(unit);

  const val = document.createElement("span");
  val.className = "val";
  if (!m.collected) {
    // Distinct from a zero reading. A metric declared in the schema that no
    // collector writes must say so — "no data" and "broken" must not look
    // identical, and neither must "no data" and "zero".
    val.classList.add("nodata");
    val.textContent = "never collected";
  } else if (m.series.length === 1) {
    val.textContent = fmtValue(m.series[0].value, m.unit);
  } else {
    val.textContent = `${m.series.length} series`;
  }

  const desc = document.createElement("span");
  desc.className = "desc";
  desc.textContent = m.description;

  row.append(name, val, desc);
  row.addEventListener("click", () => {
    selected = m.name === selected ? null : m.name;
    labelKey = null;
    syncUrl();
    render();
  });
  return row;
}

function detailFor(m) {
  const box = document.createElement("div");
  box.className = "detail";

  if (!m.collected) {
    const note = document.createElement("div");
    note.className = "empty";
    note.textContent =
      "This metric is declared in the schema but no collector has ever written a point for it.";
    box.appendChild(note);
    return box;
  }

  // Show every distinct label set so metric dimensions are discoverable.
  // Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-240
  const labelled = m.series.filter((s) => Object.keys(s.labels || {}).length > 0);
  if (labelled.length) {
    const chips = document.createElement("div");
    chips.className = "chips";
    const all = document.createElement("button");
    all.type = "button";
    all.className = "chip";
    all.textContent = `all (${labelled.length})`;
    all.setAttribute("aria-pressed", String(labelKey === null));
    all.addEventListener("click", () => { labelKey = null; syncUrl(); render(); });
    chips.appendChild(all);

    const sorted = [...labelled].sort((a, b) => b.value - a.value);
    for (const s of sorted) {
      const key = JSON.stringify(s.labels);
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.textContent = `${labelText(s.labels)} · ${fmtValue(s.value, m.unit)}`;
      chip.setAttribute("aria-pressed", String(labelKey === key));
      chip.addEventListener("click", () => {
        labelKey = labelKey === key ? null : key;
        syncUrl();
        render();
      });
      chips.appendChild(chip);
    }
    box.appendChild(chips);
  }

  const chart = document.createElement("div");
  chart.className = "spark chart";
  chart.textContent = "loading…";
  box.appendChild(chart);
  loadSeries(m, chart);
  return box;
}

async function loadSeries(m, el) {
  const p = new URLSearchParams({ metric: m.name, since: String(sinceSec) });
  if (labelKey) p.set("labels", labelKey);
  try {
    const res = await fetch(`/api/series?${p}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const points = body.points || [];
    if (points.length < 2) {
      el.textContent = "";
      const none = document.createElement("div");
      none.className = "n";
      // Collected, but not in THIS window — say which, so the reader adjusts
      // the window rather than concluding the collector is broken.
      none.textContent = `Collected, but no points in the last ${
        WINDOWS.find((w) => w.sec === sinceSec)?.label ?? "window"
      }.`;
      el.appendChild(none);
      return;
    }
    // Taller box than the stat tiles: this is the page's main chart, and the
    // viewBox grows with it so the geometry stays square.
    drawSpark(el, points, (v) => fmtValue(v, m.unit), m.name, { height: 110 });
  } catch (err) {
    // A failed request is NOT an empty series. Show it as a failure.
    el.textContent = "";
    const bad = document.createElement("div");
    bad.className = "down";
    const b = document.createElement("b");
    b.textContent = "Could not load this series. ";
    bad.append(b, document.createTextNode(String(err)));
    el.appendChild(bad);
  }
}

function renderWindows() {
  const host = $("windows");
  host.textContent = "";
  for (const w of WINDOWS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = w.label;
    b.setAttribute("aria-pressed", String(w.sec === sinceSec));
    b.addEventListener("click", () => {
      sinceSec = w.sec;
      syncUrl();
      renderWindows();
      render();
    });
    host.appendChild(b);
  }
}

async function load() {
  try {
    const res = await fetch("/api/catalog");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    catalog = body.metrics || [];
    $("stamp").textContent = `${body.total} metrics collected by this bag`;
    render();
  } catch (err) {
    $("stamp").textContent = "catalog unavailable";
    const host = $("catalog");
    host.textContent = "";
    const bad = document.createElement("div");
    bad.className = "down";
    const b = document.createElement("b");
    b.textContent = "Could not load the metric catalog. ";
    bad.append(b, document.createTextNode(String(err)));
    host.appendChild(bad);
  }
}

$("q").addEventListener("input", (e) => {
  query = e.target.value.trim();
  render();
});

renderWindows();
load();
