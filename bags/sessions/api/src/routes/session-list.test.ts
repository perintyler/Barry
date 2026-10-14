import { afterAll, beforeAll, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

vi.mock("../session-runtime.js", () => ({ sessionRuntime: {} }));
vi.mock("@barry-rocks/sessions-bag/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sessions-bag/client")>(),
  listSessions: vi.fn(async () => []),
}));
import { listSessions } from "@barry-rocks/sessions-bag/client";
import { sessionsRouter } from "./sessions.js";

let server: Server;
let baseUrl: string;
beforeAll(async () => {
  const app = express();
  app.use("/sessions", sessionsRouter);
  await new Promise<void>(resolve => {
    server = app.listen(0, () => {
      const address = server.address();
      if (address && typeof address === "object") baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});
afterAll(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

it("passes a positive identity id to the store", async () => {
  expect((await fetch(`${baseUrl}/sessions?identityId=7&fields=id`)).status).toBe(200);
  expect(listSessions).toHaveBeenCalledWith(expect.objectContaining({ identityId: 7 }));
});

it.each(["0", "-1", "1.5", "wat", ""])("refuses malformed identity id %s", async id => {
  const response = await fetch(`${baseUrl}/sessions?identityId=${id}&fields=id`);
  expect(response.status).toBe(400);
  expect(response.headers.get("content-type")).toContain("application/problem+json");
});
