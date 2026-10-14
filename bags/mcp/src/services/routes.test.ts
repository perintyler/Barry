import express from "express";
import type { Server } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Barry, BarryError, type Caller, type Service } from "@barry-rocks/sdk";
import { fakeServices } from "@barry-rocks/sdk/testing";
import { servicesRouter } from "./routes.js";
const service: Service = { key: "fixture.api", bag: "fixture", name: "api", kind: "service", state: "stopped", registered: true, enabled: true, system: false, pid: null, port: null, address: null, health: "unknown", restarts: 0, startedAt: null, lastExitCode: null, workingDirectory: "/fixture", loopbackOnly: null, conflict: null, problem: null };
let server: Server, url: string;
const get = vi.fn(async (_key: string, _caller: Caller) => service);
beforeEach(async () => {
  get.mockReset().mockResolvedValue(service);
  Barry.use(fakeServices({ list: async () => [service], get, start: get, stop: get, restart: get }));
  const app = express();
  app.use((req, _res, next) => {
    if (req.headers["x-device"]) Object.defineProperty(req, "authPrincipal", { value: { kind: "device", credentialId: "d1", actorId: 1, identityIds: [], scopes: [] } });
    next();
  });
  app.use("/api/v1/services", servicesRouter());
  server = await new Promise<Server>(resolve => { const bound = app.listen(0, "127.0.0.1", () => resolve(bound)); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("no TCP address");
  url = `http://127.0.0.1:${address.port}/api/v1/services`;
});
afterEach(async () => { Barry.reset(); await new Promise<void>(resolve => server.close(() => resolve())); });
it("serves all five declared successes", async () => {
  expect(await (await fetch(url)).json()).toEqual({ services: [service] });
  for (const [suffix, method] of [["/fixture.api", "GET"], ["/fixture.api/start", "POST"], ["/fixture.api/stop", "POST"], ["/fixture.api/restart", "POST"]]) {
    const response = await fetch(url + suffix, { method }); expect(response.status).toBe(200); expect(await response.json()).toEqual({ service });
  }
  expect(get).toHaveBeenCalledWith("fixture.api", { kind: "owner" });
});
it("validates keys and maps refusals to problem responses", async () => {
  expect((await fetch(url + "/fixture..api")).status).toBe(400);
  expect((await fetch(url + "/bad%2Fkey")).status).toBe(400);
  for (const [reason, status] of [["forbidden", 403], ["not_found", 404], ["conflict", 409]] as const) {
    get.mockRejectedValueOnce(new BarryError(reason, "fixture refusal"));
    const response = await fetch(url + "/fixture.api/restart", { method: "POST" });
    expect(response.status).toBe(status); expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toMatchObject({ type: "about:blank", status, detail: "fixture refusal" });
  }
});
it("passes a device caller and contains unexpected failures", async () => {
  await fetch(url + "/fixture.api", { headers: { "x-device": "yes" } });
  expect(get).toHaveBeenCalledWith("fixture.api", expect.objectContaining({ kind: "device" }));
  get.mockRejectedValueOnce(new Error("unexpected failure"));
  const response = await fetch(url + "/fixture.api"); expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ detail: "unexpected failure" });
});
it("checks successes against the shared strict schema under Vitest", async () => {
  get.mockResolvedValueOnce({ key: "incomplete" } as Service);
  const response = await fetch(url + "/fixture.api"); expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ title: "Invalid route response" });
});
