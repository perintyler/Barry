# Ollama embeddings

Setup records this shipped provider; use `barry adapter model add <package-directory>` for packages Barry does not ship.

Selection imports no unrelated providers and grants no credentials or permissions. The package exports compiled ESM and TypeScript declarations. Importing it or constructing a model makes no network requests. Start Ollama and pull an embedding model before calling `embed`.

```ts
import { ollamaEmbeddingModel } from "@barry-rocks/embedding-ollama";

const model = ollamaEmbeddingModel("nomic-embed-text", {
  baseUrl: "http://127.0.0.1:11434",
});
const { vectors } = await model.embed({ input: ["A searchable document"] });
```

`EMBEDDING_FACTORIES` supplies the embedding capability to Barry's selected model-provider catalog. The package shares only its Ollama transport constants with `@barry-rocks/completion-ollama`.

## Connection, environment and modes

Connects to the caller-supplied Ollama HTTP endpoint. Endpoint and credential values are explicit inputs from the caller’s model binding; importing the package does not resolve an ambient account. This is a model provider for embedding requests, rather than a hosted, instrumented or guest session launcher. See its [source entry](src/index.ts) for the exported factory and endpoint contract.
