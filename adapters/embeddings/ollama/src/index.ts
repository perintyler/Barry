import type { VendorFactories } from "@barry-rocks/sdk/adapters/models";
import { ollamaEmbeddingModel } from "./ollama.js";

export { ollamaEmbeddingModel } from "./ollama.js";

export const EMBEDDING_FACTORIES: VendorFactories = {
  embedding: { ollama: ollamaEmbeddingModel },
};
