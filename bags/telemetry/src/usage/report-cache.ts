// Coalesce concurrent usage reads and cache bounded results to protect the database event loop.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-177

const DEFAULT_TTL_MS = 30_000;

interface CacheEntry<T> {
  data: T;
  generatedAtMs: number;
}

// Return staleness with the cached value rather than requiring a second freshness request.
// Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-108
export interface CachedReport<T> {
  data: T;
  generatedAtMs: number;
  staleMs: number;
}

// Key cached reports by their requested window so unrelated queries cannot reuse the wrong result.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-178
export class ReportCache<T> {
  private readonly ttlMs: number;
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  // Share one in-flight build per key and expire completed results without caching a failed promise.
  // Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-179
  async get(key: string, build: () => Promise<T>): Promise<CachedReport<T>> {
    const now = Date.now();
    const cached = this.entries.get(key);
    if (cached && now - cached.generatedAtMs < this.ttlMs) {
      return { data: cached.data, generatedAtMs: cached.generatedAtMs, staleMs: now - cached.generatedAtMs };
    }

    const existing = this.inFlight.get(key);
    if (existing) {
      const data = await existing;
      const entry = this.entries.get(key);
      // The entry is written by whichever caller's rebuild resolves first,
      // immediately before its promise clears from `inFlight` — so by the time
      // this await returns, `entries` already has it.
      const generatedAtMs = entry?.generatedAtMs ?? Date.now();
      return { data, generatedAtMs, staleMs: Date.now() - generatedAtMs };
    }

    const promise = build();
    this.inFlight.set(key, promise);
    try {
      const data = await promise;
      const generatedAtMs = Date.now();
      this.entries.set(key, { data, generatedAtMs });
      return { data, generatedAtMs, staleMs: 0 };
    } finally {
      // Cleared regardless of success or failure: a failed rebuild must not
      // wedge every future request for this key behind a promise that will
      // never resolve again. A rejection propagates to every caller sharing
      // it, exactly once, and the next call retries fresh.
      this.inFlight.delete(key);
    }
  }

  /** Number of rebuilds currently in flight, across all keys. Test hook. */
  get pendingCount(): number {
    return this.inFlight.size;
  }
}
