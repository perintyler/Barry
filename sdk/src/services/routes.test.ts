import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { route } from "../routes/route.js";
import { serve, servedRoutes } from "./routes.js";

async function request(router: express.Router, mount: string, path: string) {
  const app = express();
  app.use(mount, router);
  const server = await new Promise<Server>(resolve => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

const value = z.strictObject({ snakeKey: z.string() });
const get = route({ method: "get", path: "/examples/{id}", operationId: "getExample", responses: { 200: value } });

describe("route registration", () => {
  it("maps collection and param paths in registration order", async () => {
    const router = express.Router();
    const registrar = serve(router, "/examples");
    const list = route({ ...get, path: "/examples", operationId: "listExamples" });
    registrar.route(list, (_req, res) => { res.json({ snakeKey: "list" }); });
    registrar.route(get, (req, res) => { res.json({ snakeKey: req.params.id }); });
    expect(servedRoutes(router)).toEqual([list, get]);
    expect(await request(router, "/examples", "/examples/one")).toEqual({ status: 200, body: { snakeKey: "one" } });
    expect(await request(router, "/examples", "/examples")).toEqual({ status: 200, body: { snakeKey: "list" } });
  });
  it("maps an absolute v2 base", async () => {
    const router = express.Router();
    const absolute = route({ ...get, path: "/api/v2/examples/{id}" });
    serve(router, "/api/v2/examples").route(absolute, (req, res) => { res.json({ snakeKey: req.params.id }); });
    expect((await request(router, "/api/v2/examples", "/api/v2/examples/two")).status).toBe(200);
  });
  it("refuses an unrelated base or mismatched method", () => {
    expect(() => serve(express.Router(), "/other").route(get, (_req, res) => { res.end(); })).toThrow("outside base");
    expect(() => serve(express.Router(), "/examples").post(get, (_req, res) => { res.end(); })).toThrow("Method mismatch");
  });
  it("answers 500 with the route and issues when the handler succeeds with a malformed body", async () => {
    const router = express.Router();
    serve(router, "/examples").route(get, (_req, res) => { res.json({ different: true }); });
    expect(await request(router, "/examples", "/examples/one")).toMatchObject({ status: 500, body: { title: "Invalid route response", detail: expect.stringContaining("GET /examples/{id}"), issues: expect.any(Array) } });
  });
  it("checks the camel response without changing what a bare router sends", async () => {
    const router = express.Router();
    serve(router, "/examples", { casing: "camel" }).route(get, (_req, res) => { res.json({ ok: true, snake_key: "one" }); });
    expect(await request(router, "/examples", "/examples/one")).toEqual({ status: 200, body: { ok: true, snake_key: "one" } });
  });
  it("leaves an undeclared error status alone", async () => {
    const router = express.Router();
    serve(router, "/examples").route(get, (_req, res) => { res.status(400).json({ error: "invalid" }); });
    expect(await request(router, "/examples", "/examples/one")).toEqual({ status: 400, body: { error: "invalid" } });
  });
});
