import { Barry } from "@barry-rocks/sdk";
import { z } from "zod";

import { ensureCollection, listCollections, searchCollection, upsertVectors } from "./store.js";
import {
  embedOne,
  embedTexts,
  embedModel,
  DEFAULT_EMBED_DIM,
  BackendUnavailableError,
} from "./embed.js";

/**
 * Tools for the vector store.
 *
 * Deliberately thin. The store is meant to be used as a LIBRARY by other bags
 * — sessions/search imports `./store` and `./embed` directly rather than going
 * through MCP — so these exist for inspection and ad-hoc use, not as the
 * primary interface.
 */

function describeUnavailable(error: unknown): string {
  if (error instanceof BackendUnavailableError) {
    return `${error.message}\n\nEmbeddings need a configured adapter. Try setting default_embeddings.adapter in your identity.yaml`;
  }
  throw error;
}

export const collections = Barry.Tool({
  namespace: "embeddings",
  access: "read",
  name: "collections",
  description:
    "List the vector collections on this machine, with the embedding model and vector count for each.",
  schema: {},
  handler: async () => {
    const all = listCollections();
    if (all.length === 0) return "No vector collections yet.";
    return all
      .map((c) => `${c.name}  ${c.count} vectors  ${c.model} (${c.dim}d)`)
      .join("\n");
  },
});

export const search = Barry.Tool({
  namespace: "embeddings",
  access: "read",
  name: "search",
  description:
    "Semantic search within a vector collection. Finds text by MEANING rather than by word match, so a query can retrieve passages that share no vocabulary with it.",
  schema: {
    collection: z.string().min(1).describe("Collection to search. See the `collections` tool."),
    query: z.string().min(1).describe("What to look for, in natural language."),
    limit: z.number().int().positive().max(100).optional().describe("How many results (default 10)."),
    adapter: z.enum(["ollama", "anthropic", "jev"]).optional().describe("Embedding adapter to use (overrides defaults)."),
  },
  handler: async ({ collection, query, limit, adapter }) => {
    let vector: number[];
    try {
      vector = await embedOne(query, adapter ? { adapter } : {});
    } catch (error) {
      return describeUnavailable(error);
    }

    // Pass the model the query was actually embedded with — BAG-26: this used
    // to be `adapter ? undefined : DEFAULT_EMBED_MODEL`, which SKIPPED the
    // model-mismatch guard whenever an adapter was named, so a collection built
    // by one model and queried through another returned plausible nonsense.
    const hits = searchCollection(collection, vector, { limit: limit ?? 10, model: embedModel() });
    if (hits.length === 0) return `No matches in "${collection}".`;

    return hits
      .map((h) => `[${h.score.toFixed(3)}] ${h.externalId}\n${h.text.slice(0, 300)}`)
      .join("\n\n");
  },
});

export const add = Barry.Tool({
  namespace: "embeddings",
  access: "write",
  name: "add",
  description:
    "Embed texts and store them in a collection. The collection is created on first use, pinned to the current embedding model.",
  schema: {
    collection: z.string().min(1).describe("Collection to write into."),
    items: z
      .array(
        z.object({
          id: z.string().min(1).describe("Your id for this text. Re-adding the same id replaces it."),
          text: z.string().min(1).describe("The text to embed."),
        }),
      )
      .min(1)
      .describe("Texts to embed and store."),
    adapter: z.enum(["ollama", "anthropic", "jev"]).optional().describe("Embedding adapter to use (overrides defaults)."),
  },
  handler: async ({ collection, items, adapter }) => {
    let vectors: number[][];
    try {
      vectors = await embedTexts(items.map((i) => i.text), adapter ? { adapter } : {});
    } catch (error) {
      return describeUnavailable(error);
    }

    // The collection is pinned to the model its vectors were actually built
    // with — BAG-26: previously this recorded DEFAULT_EMBED_MODEL via a
    // `?? DEFAULT_EMBED_MODEL` on an `undefined`, which happened to agree today
    // but detached the recorded id from the model embedModel() chose.
    const model = embedModel();
    ensureCollection(collection, model, vectors[0]?.length ?? DEFAULT_EMBED_DIM);
    const n = upsertVectors(
      collection,
      items.map((item, i) => ({ externalId: item.id, text: item.text, vector: vectors[i] })),
    );
    return `Stored ${n} vector${n === 1 ? "" : "s"} in "${collection}".`;
  },
});
