import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { ModelUnavailableError } from "@barry-rocks/sdk/adapters/models";
import { ollamaEmbeddingModel } from "./index.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

async function endpoint(server: Server): Promise<{ baseUrl: string }> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP test endpoint");
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

describe("Ollama embedding transport", () => {
  it("sends the complete batch and preserves vector order and served model", async () => {
    let requestBody: unknown;
    const server = createServer(async (request, response) => {
      expect(request.url).toBe("/api/embed");
      expect(request.method).toBe("POST");
      expect(request.headers["content-type"]).toBe("application/json");
      let text = "";
      for await (const chunk of request) text += chunk.toString();
      requestBody = JSON.parse(text);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ model: "nomic:actual", embeddings: [[1, 2], [3, 4]] }));
    });
    const model = ollamaEmbeddingModel("nomic", await endpoint(server));
    expect(await model.embed({ input: ["first", "second"] })).toEqual({
      vectors: [[1, 2], [3, 4]], servedModel: "nomic:actual",
    });
    expect(requestBody).toMatchObject({ model: "nomic", input: ["first", "second"] });
  });

  it("reports a missing pulled model as unavailable", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(404).end("not pulled");
    });
    const model = ollamaEmbeddingModel("missing", await endpoint(server));
    await expect(model.embed({ input: ["text"] })).rejects.toBeInstanceOf(ModelUnavailableError);
  });

  it("rejects a partial batch instead of pairing the wrong vectors with inputs", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ embeddings: [[1, 2]] }));
    });
    const model = ollamaEmbeddingModel("nomic", await endpoint(server));
    await expect(model.embed({ input: ["first", "second"] })).rejects.toThrow("1 embeddings for 2 inputs");
  });
});
