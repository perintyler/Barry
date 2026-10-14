import { createServer, type IncomingMessage } from "node:http";
import { afterEach, expect, it } from "vitest";
import { ownerCall, WorkerCredentialRejected } from "./worker-client.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise(resolve => server.close(resolve)); });
async function owner(answer: (request: IncomingMessage, body: string) => [number, string]): Promise<string> {
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += String(chunk);
    const [status, text] = answer(request, body);
    response.writeHead(status, { "Content-Type": "application/json" }); response.end(text);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

it("posts only the protocol request with the worker credential as a bearer token", async () => {
  let seen: { authorization?: string; path?: string; body?: string } = {};
  const url = await owner((request, body) => { seen = { authorization: request.headers.authorization, path: request.url, body }; return [200, JSON.stringify({ version: 2, owner: "o" })]; });
  expect(await ownerCall(`${url}/`, "barry_wk_secret")({ version: 2, operation: "hello", session: "s" })).toEqual({ version: 2, owner: "o" });
  expect(seen).toEqual({ authorization: "Bearer barry_wk_secret", path: "/api/worker", body: JSON.stringify({ request: { version: 2, operation: "hello", session: "s" } }) });
});

it("turns 401 and 403 into WorkerCredentialRejected and other failures into ordinary errors", async () => {
  for (const status of [401, 403]) {
    const url = await owner(() => [status, "{}"]);
    await expect(ownerCall(url, "barry_wk_x")({})).rejects.toBeInstanceOf(WorkerCredentialRejected);
  }
  const url = await owner(() => [503, JSON.stringify({ code: "Draining", message: "Owner is draining" })]);
  const failure = ownerCall(url, "barry_wk_x")({});
  await expect(failure).rejects.toThrow(/HTTP 503: Owner is draining/);
  await expect(failure).rejects.not.toBeInstanceOf(WorkerCredentialRejected);
});
