import { describe, it, expect, vi, afterEach } from "vitest";
import { collectOllama, parsePs, hasModel, toMb } from "./collect-ollama.js";
import { METRICS } from "./schema.js";

const NOW = 1_800_000_000;

/** The real shape, copied from a live `/api/ps` while qwen3:4b was loaded. */
const LOADED = {
  models: [
    {
      name: "qwen3:4b",
      model: "qwen3:4b",
      size: 3_175_339_786,
      size_vram: 3_175_339_786,
      expires_at: new Date((NOW + 60) * 1000).toISOString(),
      context_length: 4096,
      details: { parameter_size: "4.0B", quantization_level: "Q4_K_M" },
    },
  ],
};

/** The real shape when the keep-alive has expired. This is NORMAL, not a fault. */
const IDLE = { models: [] };

const TAGS = { models: [{ name: "qwen3:4b", model: "qwen3:4b" }] };

function mockFetch(byPath: Record<string, unknown>) {
  return vi.fn(async (url: string | URL) => {
    const path = new URL(String(url)).pathname;
    const hit = byPath[path];
    if (hit === undefined) throw new Error(`unexpected path ${path}`);
    if (hit instanceof Error) throw hit;
    return { ok: true, json: async () => hit } as Response;
  });
}

const valueOf = (points: { metric: string; value: number; labels?: Record<string, string> }[], metric: string, labels?: Record<string, string>) =>
  points.find(
    (p) => p.metric === metric && (labels === undefined || JSON.stringify(p.labels ?? {}) === JSON.stringify(labels)),
  )?.value;

describe("collectOllama", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Emit collector health so idle Ollama and stopped Ollama remain distinguishable.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-008
  it("distinguishes unreachable from idle", async () => {
    vi.stubGlobal("fetch", mockFetch({ "/api/ps": new Error("ECONNREFUSED") }));
    const down = await collectOllama(NOW);

    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", mockFetch({ "/api/ps": IDLE, "/api/tags": TAGS }));
    const idle = await collectOllama(NOW);

    // Both report no memory in use...
    expect(valueOf(idle, METRICS.ollamaLoadedMb.name)).toBe(0);
    expect(valueOf(down, METRICS.ollamaLoadedMb.name)).toBeUndefined();

    // ...and the collectorOk point is the only thing that tells them apart.
    expect(valueOf(down, METRICS.collectorOk.name, { tool: "ollama" })).toBe(0);
    expect(valueOf(idle, METRICS.collectorOk.name, { tool: "ollama" })).toBe(1);
  });

  it("records the loaded model's real resident size", async () => {
    vi.stubGlobal("fetch", mockFetch({ "/api/ps": LOADED, "/api/tags": TAGS }));
    const points = await collectOllama(NOW);

    // 3,175,339,786 bytes as measured live.
    expect(valueOf(points, METRICS.ollamaLoadedMb.name)).toBeCloseTo(3028.2, 0);
    expect(valueOf(points, METRICS.ollamaLoadedMb.name, { model: "qwen3:4b" })).toBeCloseTo(3028.2, 0);
    expect(valueOf(points, METRICS.ollamaModelExpiresSec.name, { model: "qwen3:4b" })).toBe(60);
  });

  // Emit continuous totals after model unload so an alert can satisfy its clearing threshold.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-009
  it("emits an unlabelled total of zero when idle, not nothing", async () => {
    vi.stubGlobal("fetch", mockFetch({ "/api/ps": IDLE, "/api/tags": TAGS }));
    const points = await collectOllama(NOW);

    const total = points.filter((p) => p.metric === METRICS.ollamaLoadedMb.name && !p.labels);
    expect(total).toHaveLength(1);
    expect(total[0].value).toBe(0);
  });

  it("reports a missing model as installed=0 rather than omitting it", async () => {
    vi.stubGlobal("fetch", mockFetch({ "/api/ps": IDLE, "/api/tags": { models: [{ name: "llama3:8b" }] } }));
    const points = await collectOllama(NOW);
    expect(valueOf(points, METRICS.ollamaModelInstalled.name, { model: "qwen3:4b" })).toBe(0);
  });

  // Partial daemon failure must not prevent unrelated collectors from recording their results.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-010
  it("keeps the ps metrics when the tags call fails", async () => {
    vi.stubGlobal("fetch", mockFetch({ "/api/ps": LOADED, "/api/tags": new Error("boom") }));
    const points = await collectOllama(NOW);

    expect(valueOf(points, METRICS.collectorOk.name, { tool: "ollama" })).toBe(1);
    expect(valueOf(points, METRICS.ollamaLoadedMb.name)).toBeCloseTo(3028.2, 0);
    expect(valueOf(points, METRICS.ollamaModelInstalled.name, { model: "qwen3:4b" })).toBeUndefined();
  });
});

describe("parsePs", () => {
  it("prefers size_vram over the smaller on-disk size", () => {
    const [m] = parsePs({ models: [{ name: "m", size: 100, size_vram: 900 }] });
    expect(m.sizeVramBytes).toBe(900);
  });

  it("survives garbage without throwing", () => {
    expect(parsePs(null)).toEqual([]);
    expect(parsePs({})).toEqual([]);
    expect(parsePs({ models: "nope" })).toEqual([]);
    expect(parsePs({ models: [null, 3, { noName: true }] })).toEqual([]);
  });
});

describe("hasModel", () => {
  it("matches on either name or model", () => {
    expect(hasModel({ models: [{ name: "qwen3:4b" }] }, "qwen3:4b")).toBe(true);
    expect(hasModel({ models: [{ model: "qwen3:4b" }] }, "qwen3:4b")).toBe(true);
    expect(hasModel({ models: [{ name: "other" }] }, "qwen3:4b")).toBe(false);
    expect(hasModel(null, "qwen3:4b")).toBe(false);
  });
});

describe("toMb", () => {
  it("converts bytes using the same MiB base as every other memory metric", () => {
    expect(toMb(1_048_576)).toBe(1);
    expect(toMb(3_175_339_786)).toBeCloseTo(3028.2, 1);
  });
});
