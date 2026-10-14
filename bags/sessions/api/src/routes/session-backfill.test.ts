import { beforeAll, afterAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const records = vi.hoisted(() => new Map<string, { id: string; metadata: Record<string, unknown> }>());
vi.mock("../db.js", async importOriginal => ({
  ...await importOriginal<typeof import("../db.js")>(),
  getSessionRecord: vi.fn(async (id: string) => records.get(id)),
  getSessionMessages: vi.fn(async () => ({ messages: [] })),
  appendMessage: vi.fn(async () => undefined),
}));
import { appendMessage } from "../db.js";
import { sessionLifecycleRouter } from "./session-lifecycle.js";
import { setInstalledTranscriptReaders } from "../transcript-readers.js";

let server: Server, base: string, scratch: string, root: string, transcript: string, outside: string;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use("/api/v1/sessions", sessionLifecycleRouter);
  await new Promise<void>(resolve => {
    server = app.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing test server address");
      base = `http://127.0.0.1:${address.port}/api/v1/sessions`; resolve();
    });
  });
});
afterAll(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
beforeEach(() => {
  vi.clearAllMocks(); records.clear();
  scratch = mkdtempSync(join(tmpdir(), "barry-backfill-")); root = join(scratch, "allowed"); mkdirSync(root);
  transcript = join(root, "transcript.jsonl"); outside = join(scratch, "private.jsonl");
  const line = JSON.stringify({ type: "user", message: { content: "recorded user message" } }) + "\n";
  writeFileSync(transcript, line); writeFileSync(outside, line);
  records.set("recorded", { id: "recorded", metadata: { provider: "fixture", transcript_path: transcript } });
  setInstalledTranscriptReaders(async () => ({ fixture: { locate: async () => null, read: async () => ({ events: [], linesRead: 0, entriesParsed: 0 }), roots: async () => [root] } }));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));
const post = (id: string, body: unknown = {}) => fetch(`${base}/${id}/backfill`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
it("rejects body-selected files and unknown sessions before acknowledging or inserting", async () => {
  expect((await post("recorded", { transcriptPath: outside })).status).toBe(400);
  expect((await post("missing", { transcriptPath: transcript })).status).toBe(404);
  expect(appendMessage).not.toHaveBeenCalled();
});
it("rejects a recorded file outside declared roots and a symlink escape", async () => {
  records.get("recorded")!.metadata.transcript_path = outside;
  expect((await post("recorded", { transcriptPath: outside })).status).toBe(400);
  const link = join(root, "escape.jsonl"); symlinkSync(outside, link);
  records.get("recorded")!.metadata.transcript_path = link;
  expect((await post("recorded", { transcriptPath: link })).status).toBe(400);
  expect(appendMessage).not.toHaveBeenCalled();
});
it("fails closed for an adapter with no root declaration", async () => {
  setInstalledTranscriptReaders(async () => ({ fixture: { locate: async () => transcript, read: async () => ({ events: [], linesRead: 0, entriesParsed: 0 }) } }));
  expect((await post("recorded", { transcriptPath: transcript })).status).toBe(400);
  expect(appendMessage).not.toHaveBeenCalled();
});
it("backfills the session's own recorded file with an optional matching body field", async () => {
  expect((await post("recorded", { transcriptPath: transcript })).status).toBe(202);
  await vi.waitFor(() => expect(appendMessage).toHaveBeenCalledWith("recorded", { type: "text", role: "user", content: "recorded user message" }));
  vi.mocked(appendMessage).mockClear();
  expect((await post("recorded")).status).toBe(202);
  await vi.waitFor(() => expect(appendMessage).toHaveBeenCalledTimes(1));
});
