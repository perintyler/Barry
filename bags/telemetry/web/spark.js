// Share dashboard rendering and polling behavior so pages handle failure consistently.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-242

/** Element by id. */
export const $ = (id) => document.getElementById(id);

/**
 * @param {object} [opts]
 * @param {number} [opts.height] viewBox height. Defaults to the 34px tile
 *   geometry every stat card uses. A detail chart passes a taller box so the
 *   line has room; because the marker radius and stroke are expressed in
 *   viewBox units, drawing a tall chart by CSS-stretching the 34px box instead
 *   would scale y ~3.5x more than x and turn the round end marker into an
 *   ellipse.
 */
export function drawSpark(el, points, fmt, label, opts = {}) {
  el.textContent = "";
  if (!points || points.length < 2) {
    const empty = document.createElement("div");
    empty.className = "n";
    empty.textContent = "collecting…";
    el.appendChild(empty);
    return;
  }

  // PAD_X exists because the stroke and the end marker are drawn in device
  // pixels (vector-effect: non-scaling-stroke) while x is in viewBox units:
  // a point at x=W lands its 2.5px dot half outside the card. Inset both ends.
  const W = 100, H = opts.height ?? 34, PAD = 3, PAD_X = 2;
  const xs = points.map((p) => p.ts);
  const ys = points.map((p) => p.value);
  const x0 = xs[0], x1 = xs[xs.length - 1];
  const lo = Math.min(...ys), hi = Math.max(...ys);
  // A flat series must not collapse onto the baseline or explode to full height;
  // a nonzero span keeps it drawn as the straight line it is.
  const span = hi - lo || Math.max(Math.abs(hi) * 0.1, 1);
  const sx = (t) =>
    x1 === x0 ? W / 2 : PAD_X + ((t - x0) / (x1 - x0)) * (W - PAD_X * 2);
  const sy = (v) => H - PAD - ((v - lo) / span) * (H - PAD * 2);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label",
    `${label}: ${points.length} samples, ${fmt(ys[0])} to ${fmt(ys[ys.length - 1])}`);

  const d = points.map((p, i) => `${i ? "L" : "M"}${sx(p.ts).toFixed(2)},${sy(p.value).toFixed(2)}`).join("");
  const area = document.createElementNS("http://www.w3.org/2000/svg", "path");
  area.setAttribute("class", "fill");
  area.setAttribute("d", `${d}L${sx(x1).toFixed(2)},${H}L${sx(x0).toFixed(2)},${H}Z`);
  svg.appendChild(area);

  const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
  line.setAttribute("class", "line");
  line.setAttribute("d", d);
  line.setAttribute("vector-effect", "non-scaling-stroke");
  svg.appendChild(line);

  const cross = document.createElementNS("http://www.w3.org/2000/svg", "line");
  cross.setAttribute("class", "cross");
  cross.setAttribute("y1", "0");
  cross.setAttribute("y2", String(H));
  cross.setAttribute("vector-effect", "non-scaling-stroke");
  svg.appendChild(cross);

  // Radius in viewBox units, scaled so the marker renders at a constant size
  // regardless of how tall the box is.
  const R = (2.5 * 34) / H;
  const now = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  now.setAttribute("class", "now");
  now.setAttribute("r", String(R));
  now.setAttribute("cx", String(sx(x1)));
  now.setAttribute("cy", String(sy(ys[ys.length - 1])));
  now.setAttribute("vector-effect", "non-scaling-stroke");
  svg.appendChild(now);

  const cursor = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  cursor.setAttribute("class", "cursor");
  cursor.setAttribute("r", String(R));
  cursor.setAttribute("vector-effect", "non-scaling-stroke");
  svg.appendChild(cursor);

  const hit = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  hit.setAttribute("class", "hit");
  hit.setAttribute("width", String(W));
  hit.setAttribute("height", String(H));
  hit.setAttribute("tabindex", "0");
  svg.appendChild(hit);

  const tip = document.createElement("div");
  tip.className = "sparktip";
  el.appendChild(svg);
  el.appendChild(tip);

  const show = (i) => {
    const pt = points[i];
    if (!pt) return;
    const px = sx(pt.ts);
    cross.setAttribute("x1", String(px));
    cross.setAttribute("x2", String(px));
    cursor.setAttribute("cx", String(px));
    cursor.setAttribute("cy", String(sy(pt.value)));
    tip.textContent = "";
    const b = document.createElement("b");
    b.textContent = fmt(pt.value);
    const when = document.createElement("span");
    when.textContent = ` · ${new Date(pt.ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    tip.appendChild(b);
    tip.appendChild(when);
    tip.style.left = `${(px / W) * 100}%`;
    tip.style.top = "-2px";
  };

  const nearest = (clientX) => {
    const r = svg.getBoundingClientRect();
    const t = x0 + ((clientX - r.left) / r.width) * (x1 - x0);
    let best = 0, bd = Infinity;
    points.forEach((p, i) => {
      const dd = Math.abs(p.ts - t);
      if (dd < bd) { bd = dd; best = i; }
    });
    return best;
  };

  hit.addEventListener("pointermove", (e) => show(nearest(e.clientX)));
  // Keyboard reaches the same readout as hover.
  hit.addEventListener("focus", () => show(points.length - 1));
  hit.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const cur = Number(hit.dataset.i ?? points.length - 1);
    const next = Math.max(0, Math.min(points.length - 1, cur + (e.key === "ArrowRight" ? 1 : -1)));
    hit.dataset.i = String(next);
    show(next);
  });
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/**
 * Pause hidden-tab polling and back off failures without retrying faster than the base interval.
 * See docs/decisions/0021-telemetry-polling-and-adapter-regressions.md.
 *
 * @param {() => Promise<void>} refresh
 * @param {number} intervalMs
 * @param {object} [opts]
 * @param {number} [opts.maxIntervalMs] Ceiling for the backoff. Defaults to
 *   8x the base interval.
 * @returns {() => void} Stops the loop. Exists mainly for tests; pages
 *   otherwise run it for the lifetime of the document.
 */
export function schedulePolling(refresh, intervalMs, opts = {}) {
  const maxIntervalMs = opts.maxIntervalMs ?? intervalMs * 8;
  let timer = null;
  let currentIntervalMs = intervalMs;
  let stopped = false;

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const tick = async () => {
    if (stopped) return;
    // Backgrounded: do not fetch, and do not even keep a timer running —
    // `visibilitychange` below re-arms one immediately on return.
    if (typeof document !== "undefined" && document.visibilityState !== "visible") {
      clear();
      return;
    }
    try {
      await refresh();
      currentIntervalMs = intervalMs;
    } catch {
      // `refresh` implementations here already catch their own fetch errors
      // and render a failure state, so reaching this branch means something
      // more surprising went wrong. Back off rather than retry at full speed.
      currentIntervalMs = Math.min(currentIntervalMs * 2, maxIntervalMs);
    }
    if (stopped) return;
    clear();
    timer = setTimeout(tick, currentIntervalMs);
  };

  const onVisible = () => {
    if (stopped) return;
    if (document.visibilityState !== "visible") {
      clear();
      return;
    }
    // Coming back into view: refresh immediately rather than waiting out
    // whatever fraction of the interval had elapsed when the tab was hidden,
    // so the page is not showing minutes-old data right when someone looks.
    if (timer === null) void tick();
  };

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisible);
  }
  void tick();

  return () => {
    stopped = true;
    clear();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisible);
    }
  };
}
