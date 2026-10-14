import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createWebhooksRouter } from "./webhooks.js";

let home: string;
let previousHome: string | undefined;
let previousKey: string | undefined;
let server: Server;
let url: string;
const now = 1_730_000_000_000;
beforeEach(async () => {
  previousHome = process.env.BARRY_HOME;
  previousKey = process.env.MAILGUN_SIGNING_KEY;
  home = mkdtempSync(join(tmpdir(), "mailgun-owned-key-"));
  process.env.BARRY_HOME = home;
  process.env.MAILGUN_SIGNING_KEY = "ambient-wrong";
  mkdirSync(join(home, "config"));
  mkdirSync(join(home, "app-support"));
  const app = express();
  app.use(express.json());
  app.use(createWebhooksRouter({ now: () => now }));
  await new Promise<void>(resolve => {
    server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing test listener");
      url = `http://127.0.0.1:${address.port}/mailgun/incoming`;
      resolve();
    });
  });
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (previousHome === undefined) delete process.env.BARRY_HOME; else process.env.BARRY_HOME = previousHome;
  if (previousKey === undefined) delete process.env.MAILGUN_SIGNING_KEY; else process.env.MAILGUN_SIGNING_KEY = previousKey;
  rmSync(home, { recursive: true, force: true });
});
function configure(key: string) {
  writeFileSync(join(home, "config", "barry.yaml"), "secrets:\n  MAILGUN_SIGNING_KEY: {in: .env}\n");
  writeFileSync(join(home, "app-support", "env"), `MAILGUN_SIGNING_KEY=${key}\n`);
}
function payload(key: string, offset = 0) {
  const timestamp = String(Math.floor(now / 1000) + offset);
  const token = "fixture-token";
  return { timestamp, token, signature: createHmac("sha256", key).update(timestamp + token).digest("hex") };
}
function post(body: unknown) {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
describe("Mailgun installation signing binding", () => {
  it("stays disabled without a declaration even when the shell has a valid key", async () => {
    expect((await post(payload("ambient-wrong"))).status).toBe(403);
  });
  it("uses the selected private binding and observes rotation on the next request", async () => {
    configure("first-owned-key");
    expect((await post({ ...payload("first-owned-key"), "body-plain": {}, "stripped-text": [] })).status).toBe(200);
    expect((await post(payload("ambient-wrong"))).status).toBe(403);
    configure("rotated-owned-key");
    expect((await post(payload("first-owned-key"))).status).toBe(403);
    expect((await post(payload("rotated-owned-key"))).status).toBe(200);
  });
  it("fails authored missing values without ambient fallback or secret details", async () => {
    configure("");
    const response = await post(payload("ambient-wrong"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: "Webhook signing configuration is unavailable" });
  });
  it("rejects stale, future, and malformed signature inputs", async () => {
    configure("owned-key");
    for (const offset of [-300, 300]) expect((await post(payload("owned-key", offset))).status).toBe(200);
    for (const offset of [-301, 301]) expect((await post(payload("owned-key", offset))).status).toBe(403);
    for (const body of [{ ...payload("owned-key"), timestamp: "123junk" }, { ...payload("owned-key"), token: {} }, { ...payload("owned-key"), signature: "bad" }]) {
      expect((await post(body)).status).toBe(400);
    }
  });
});
