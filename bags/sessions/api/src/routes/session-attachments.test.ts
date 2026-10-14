import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
vi.mock("../db.js", async importOriginal => ({
  ...await importOriginal<typeof import("../db.js")>(),
  getSessionRecord: vi.fn(async (id: string) => id.startsWith("sess_att") ? { id, metadata: {} } : undefined),
  appendMessage: vi.fn(async () => undefined),
}));

vi.mock("@barry-rocks/sessions-bag/execution-authorization", () => ({ authorizeSessionExecution: vi.fn(async () => ({ kind: "installation", actorId: 1, credentialId: "installation" })) }));
import { authorizeSessionExecution } from "@barry-rocks/sessions-bag/execution-authorization";
import { sessionLifecycleRouter } from "./session-lifecycle.js";

describe("session attachments routes", () => {
  let tmpHome: string;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { Object.defineProperty(req, "authPrincipal", { value: { kind: "installation", actorId: 1, credentialId: "installation" }, configurable: true }); next(); });
    // Mounted as index.ts mounts it. This test once mounted it at /api/v1, which
    // made routes declared as /sessions/:id/attachments look right while the
    // real service answered them only at /api/v1/sessions/sessions/:id/….
    app.use("/api/v1/sessions", sessionLifecycleRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}/api/v1`;
        }
        resolve();
      });
    });
  });

  afterAll(() => {
    server?.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    tmpHome = mkdtempSync(join(tmpdir(), "barry-att-test-"));
    vi.stubEnv("BARRY_HOME", tmpHome);
  });

  it("rejects malformed IDs and unknown sessions before touching attachment storage", async () => {
    for (const method of ["POST", "GET"]) {
      const response = await fetch(`${baseUrl}/sessions/..%2F..%2Fx/attachments`, { method, ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "x.txt", mimeType: "text/plain", content: "secret" }) } : {}) });
      expect(response.status).toBe(400);
      const unknown = await fetch(`${baseUrl}/sessions/missing/attachments`, { method, ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "x.txt", mimeType: "text/plain", content: "secret" }) } : {}) });
      expect(unknown.status).toBe(404);
    }
    expect((await fetch(`${baseUrl}/sessions/missing/attachments/att_missing?raw=1`)).status).toBe(404);
    expect(existsSync(join(tmpHome, "app-support", "attachments"))).toBe(false);
    expect(authorizeSessionExecution).not.toHaveBeenCalled();
  });

  it("downloads active content as an attachment with safe ASCII and Unicode filenames", async () => {
    const name = 'report" café.html';
    const upload = await fetch(`${baseUrl}/sessions/sess_att_headers/attachments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, mimeType: "text/html", content: "<script>untrusted()</script>" }) });
    const data = await upload.json();
    const download = await fetch(`${baseUrl}/sessions/sess_att_headers/attachments/${data.attachment.id}?raw=1`);
    expect(download.headers.get("content-disposition")).toBe(`attachment; filename="report_ caf_.html"; filename*=UTF-8''${encodeURIComponent(name).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`);
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("uploads, lists, and downloads attachments", async () => {
    const sessionId = "sess_att_1";

    // 1. Upload
    const uploadRes = await fetch(`${baseUrl}/sessions/${sessionId}/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "test.txt",
        mimeType: "text/plain",
        content: "hello attachment world",
      }),
    });

    expect(uploadRes.status).toBe(201);
    const uploadJson = (await uploadRes.json());
    expect(uploadJson.ok).toBe(true);
    const attachment = uploadJson.attachment;
    expect(attachment.name).toBe("test.txt");
    expect(attachment.mimeType).toBe("text/plain");
    expect(attachment.size).toBe(22);

    // 2. List
    const listRes = await fetch(`${baseUrl}/sessions/${sessionId}/attachments`);
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json());
    expect(listJson.attachments).toHaveLength(1);
    expect(listJson.attachments[0].id).toBe(attachment.id);

    // 3. Get metadata
    const metaRes = await fetch(`${baseUrl}/sessions/${sessionId}/attachments/${attachment.id}`);
    expect(metaRes.status).toBe(200);
    const metaJson = (await metaRes.json());
    expect(metaJson.attachment.name).toBe("test.txt");

    // 4. Download raw
    const rawRes = await fetch(`${baseUrl}/sessions/${sessionId}/attachments/${attachment.id}?download=1`);
    expect(rawRes.status).toBe(200);
    expect(await rawRes.text()).toBe("hello attachment world");
  });

  it("refuses upload with missing fields or unallowed MIME", async () => {
    const sessionId = "sess_att_2";

    // Missing fields
    const res1 = await fetch(`${baseUrl}/sessions/${sessionId}/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "foo.txt" }),
    });
    expect(res1.status).toBe(400);

    // Disallowed MIME
    const res2 = await fetch(`${baseUrl}/sessions/${sessionId}/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "malicious.exe",
        mimeType: "application/x-dosexec",
        content: "evil",
      }),
    });
    expect(res2.status).toBe(415);
    const json2 = (await res2.json());
    expect(json2.error).toMatch(/unsupported media type/i);
  });

  it("materializes attachments into session project root and degrades gracefully when unavailable", async () => {
    const { sessionRuntime } = await import("../session-runtime.js");
    const sessionId = "sess_att_mat";

    // Create an attachment first
    const uploadRes = await fetch(`${baseUrl}/sessions/${sessionId}/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "data.json",
        mimeType: "application/json",
        content: JSON.stringify({ key: "value" }),
      }),
    });
    const uploadJson = (await uploadRes.json());
    const attId = uploadJson.attachment.id;

    // Test 1: With project root -> materializes file and references path
    const projectDir = mkdtempSync(join(tmpdir(), "barry-proj-"));
    try {
      const activeSession1 = {
        id: sessionId,
        sessionId,
        repoPath: projectDir,
        logger: { warn: vi.fn(), info: vi.fn() },
      };
      // Exercise the private materialization seam with only the fields it reads.
      const materialize = Reflect.get(sessionRuntime, "materializeAndFormatAttachments") as
        (session: typeof activeSession1 | { id: string; sessionId: string; repoPath: undefined; logger: typeof activeSession1.logger }, ids: string[]) => Promise<string>;
      const prefix1 = await materialize.call(sessionRuntime, activeSession1, [attId]);
      expect(prefix1).toContain("<attachments>");
      expect(prefix1).toContain(".barry/attachments");
      expect(existsSync(join(projectDir, ".barry/attachments", attId, "data.json"))).toBe(true);

      // Test 2: Inaccessible/no repoPath -> degrades gracefully to text context without throwing
      const activeSession2 = {
        id: sessionId,
        sessionId,
        repoPath: undefined,
        logger: { warn: vi.fn(), info: vi.fn() },
      };
      const prefix2 = await materialize.call(sessionRuntime, activeSession2, [attId]);
      expect(prefix2).toContain("<attachments>");
      expect(prefix2).toContain("File cannot be materialized to filesystem under current session bounds");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
