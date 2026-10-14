import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createModels, installModels, defineVendor } from "@barry-rocks/sdk/adapters/models";

import { setDb, closeDb } from "../src/db.js";
import { ensureCollection, upsertVectors } from "../src/store.js";
import { search } from "../src/tools.js";
import { DEFAULT_EMBED_MODEL, DEFAULT_EMBED_DIM } from "../src/embed.js";

/**
 * BAG-26: the search tool passed `model: adapter ? undefined : DEFAULT_EMBED_MODEL`
 * to searchCollection, so naming an adapter SKIPPED the model-mismatch guard and
 * a collection built by one model, queried through another, returned plausible
 * nonsense. The tool now always passes the model the query was embedded with.
 */
const vendors = [
  defineVendor({
    id: "ollama",
    label: "Ollama",
    baseUrl: "http://ollama.test",
    credential: null,
    models: [{ id: DEFAULT_EMBED_MODEL, label: "Nomic", kind: "embedding" }],
    embedding: (model) => ({
      ref: `ollama/${model}`,
      // Return a vector of the collection's width so the ONLY thing that can
      // fail is the model-identity check, not a dimension mismatch.
      embed: async ({ input }) => ({
        vectors: input.map(() => Array.from({ length: DEFAULT_EMBED_DIM }, () => 0.1)),
        servedModel: model,
      }),
    }),
  }),
];

const SLOT = Symbol.for("barry.models.v1");

beforeEach(() => {
  setDb(new Database(":memory:"));
  installModels(createModels(vendors, { env: {} }));
});
afterEach(() => {
  closeDb();
  delete (globalThis as Record<symbol, unknown>)[SLOT];
});

describe("search model-mismatch guard with an adapter (BAG-26)", () => {
  it("surfaces a mismatch even when an adapter is named", async () => {
    // Collection built with a DIFFERENT model than the query will use.
    ensureCollection("c", "some-other-model", DEFAULT_EMBED_DIM);
    upsertVectors("c", [
      { externalId: "a", text: "t", vector: Array.from({ length: DEFAULT_EMBED_DIM }, () => 0.2) },
    ]);

    // With the bug, passing an adapter skipped the check and this resolved to
    // meaningless hits. Now it must reject.
    await expect(
      search.handler({ collection: "c", query: "anything", adapter: "ollama" }),
    ).rejects.toThrow(/meaningless|holds some-other-model/);
  });

  it("still returns hits when the models agree", async () => {
    ensureCollection("c", DEFAULT_EMBED_MODEL, DEFAULT_EMBED_DIM);
    upsertVectors("c", [
      { externalId: "a", text: "hello", vector: Array.from({ length: DEFAULT_EMBED_DIM }, () => 0.2) },
    ]);
    const out = (await search.handler({ collection: "c", query: "hello", adapter: "ollama" })) as string;
    expect(out).toContain("a");
  });
});
