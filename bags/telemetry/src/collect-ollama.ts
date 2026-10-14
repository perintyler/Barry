// Measure the local Ollama daemon separately from Barry supervisor-owned services.
// Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-018

import type { MetricPoint } from "./schema.js";
import { METRICS } from "./schema.js";

// Keep the local Ollama port here to avoid a cross-bag package dependency for one constant.
// Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-019
const OLLAMA_URL = process.env.BARRY_OLLAMA_URL || "http://127.0.0.1:11434";

// Track the selected bookkeeping model so an accidental larger-model swap is observable.
// Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-020
const EXPECTED_MODEL = process.env.BARRY_BOOKKEEPING_MODEL || "qwen3:4b";

// A request timeout contains hangs; allSettled alone only contains rejected requests.
// Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-021
const TIMEOUT_MS = 3_000;

interface LoadedModel {
  name: string;
  sizeVramBytes: number;
  expiresAtMs: number | null;
  contextLength: number | null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Bytes to MB, rounded to two places — the unit every other memory metric uses. */
export function toMb(bytes: number): number {
  return Math.round((bytes / 1_048_576) * 100) / 100;
}

// Fixture-tested parsing distinguishes malformed daemon responses from idle models.
// Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-022
export function parsePs(body: unknown): LoadedModel[] {
  if (!body || typeof body !== "object") return [];
  const models = (body as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];

  const out: LoadedModel[] = [];
  for (const raw of models) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    const name = typeof m.name === "string" ? m.name : typeof m.model === "string" ? m.model : null;
    // `size_vram` is what is actually resident. `size` is the on-disk figure and
    // is smaller; using it would understate the thing this collector exists to
    // measure.
    const size = num(m.size_vram) ?? num(m.size);
    if (!name || size === null) continue;

    const expiresRaw = typeof m.expires_at === "string" ? Date.parse(m.expires_at) : NaN;
    out.push({
      name,
      sizeVramBytes: size,
      expiresAtMs: Number.isFinite(expiresRaw) ? expiresRaw : null,
      contextLength: num(m.context_length),
    });
  }
  return out;
}

/** Is `want` among the installed models `/api/tags` reports? */
export function hasModel(body: unknown, want: string): boolean {
  if (!body || typeof body !== "object") return false;
  const models = (body as { models?: unknown }).models;
  if (!Array.isArray(models)) return false;
  return models.some((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const m = raw as Record<string, unknown>;
    return m.name === want || m.model === want;
  });
}

async function getJson(url: string): Promise<unknown> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    // Connection refused, DNS, timeout, malformed JSON — all one thing to the
    // caller, which records collectorOk=0. The DISTINCTION that matters here is
    // reachable-vs-not, and that is what gets recorded; finer detail would not
    // change what a reader does about it.
    return null;
  }
}

// Always emit collector health; zero loaded models alone cannot distinguish idle from stopped.
// Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-023
export async function collectOllama(now: number): Promise<MetricPoint[]> {
  const ok = (value: 0 | 1): MetricPoint => ({
    ts: now,
    metric: METRICS.collectorOk.name,
    value,
    labels: { tool: "ollama" },
  });

  const ps = await getJson(`${OLLAMA_URL}/api/ps`);
  if (ps === null) return [ok(0)];

  const points: MetricPoint[] = [ok(1)];
  const loaded = parsePs(ps);

  // The unlabelled total, ALWAYS emitted — 0 when nothing is loaded. This is
  // the series a rule can watch. Per-model series below simply stop existing
  // when a model unloads, and a series that goes silent rather than reporting a
  // low value can never satisfy an alert's clearLimit: that is precisely how
  // `process-footprint-outsized` stayed firing on an exited process for a week.
  let totalMb = 0;
  for (const m of loaded) totalMb += toMb(m.sizeVramBytes);
  points.push({ ts: now, metric: METRICS.ollamaLoadedMb.name, value: totalMb });

  for (const m of loaded) {
    points.push({
      ts: now,
      metric: METRICS.ollamaLoadedMb.name,
      value: toMb(m.sizeVramBytes),
      labels: { model: m.name },
    });
    if (m.expiresAtMs !== null) {
      points.push({
        ts: now,
        metric: METRICS.ollamaModelExpiresSec.name,
        value: Math.round((m.expiresAtMs - now * 1000) / 1000),
        labels: { model: m.name },
      });
    }
  }

  // A separate call, and a separate failure: /api/ps answering while /api/tags
  // does not is odd enough that guessing would be worse than recording nothing.
  const tags = await getJson(`${OLLAMA_URL}/api/tags`);
  if (tags !== null) {
    points.push({
      ts: now,
      metric: METRICS.ollamaModelInstalled.name,
      value: hasModel(tags, EXPECTED_MODEL) ? 1 : 0,
      labels: { model: EXPECTED_MODEL },
    });
  }

  return points;
}
