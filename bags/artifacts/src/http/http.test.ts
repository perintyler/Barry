import { describe, expect, it, vi } from "vitest";
import { createArtifactHttpHandler, type ArtifactHttpServerOptions } from "./router.js";
import { ArtifactHttpClient } from "./client.js";
import { createArtifactCore, type ArtifactRepository } from "../core.js";
import { ArtifactRecordSchema, type ArtifactGrant, type ArtifactRecord, type ShareGrantRecord } from "../types.js";
import { createHash } from "node:crypto";

const initialRecord = (): ArtifactRecord => ArtifactRecordSchema.parse({
  id: "artifact-http-1",
  identityId: "tester",
  content: {
    filename: "report.md",
    mimeType: "text/markdown",
    size: 13,
    sha256: createHash("sha256").update("Hello world!\n").digest("hex"),
    kind: "markdown",
    createdAt: "2026-10-06T12:00:00.000Z",
    creator: { actorId: 1, identityId: "tester" },
    sessionId: "sess-1",
    derivedFrom: null,
  },
  metadata: {
    title: "Initial Report",
    tags: ["report", "initial"],
    revision: 1,
    updatedAt: "2026-10-06T12:00:00.000Z",
  },
});

function setupHttpEnv(overrides: Partial<ArtifactHttpServerOptions> = {}) {
  let savedRecord = initialRecord();
  const shares = new Map<string, ShareGrantRecord>();
  let shareSeq = 0;

  const repository: ArtifactRepository = {
    identityId: "tester",
    async get(id: string) {
      return id === savedRecord.id ? savedRecord : undefined;
    },
    async list() {
      return [savedRecord];
    },
    transaction(op) {
      return op({
        get: id => (id === savedRecord.id ? savedRecord : undefined),
        replaceMetadata(_id, expected, metadata) {
          if (savedRecord.metadata.revision !== expected) return false;
          savedRecord = ArtifactRecordSchema.parse({ ...savedRecord, metadata });
          return true;
        },
        getShare: id => shares.get(id),
        createShare: share => {
          shares.set(share.id, share);
        },
        updateShare: (id, expected, update) => {
          const existing = shares.get(id);
          if (!existing || existing.revision !== expected) return false;
          shares.set(id, { ...existing, ...update });
          return true;
        },
        revokeShare: id => {
          const existing = shares.get(id);
          if (!existing) return false;
          shares.set(id, { ...existing, revoked: true });
          return true;
        },
      });
    },
    async getShare(id: string) {
      return shares.get(id);
    },
    async getShareByTokenHash(tokenHash: string) {
      for (const s of shares.values()) {
        if (s.tokenHash === tokenHash) return s;
      }
      return undefined;
    },
    async listShares(artifactId: string) {
      return Array.from(shares.values()).filter(s => s.artifactId === artifactId);
    },
  };

  const grant: ArtifactGrant = { actorId: 1, identityId: "tester", credentialId: "cred-1" };
  const core = createArtifactCore({
    repository,
    access: {
      async authorize() {
        return grant;
      },
    },
    blobs: {
      async verify() {},
      async *stream() {
        yield new TextEncoder().encode("Hello world!\n");
      },
    },
    now: () => "2026-10-06T12:05:00.000Z",
    newId: () => `share-${++shareSeq}`,
    hashToken: async token => createHash("sha256").update(token).digest("hex"),
    hashPassword: async (pwd, salt) => createHash("sha256").update(pwd + salt).digest("hex"),
  });

  const handler = createArtifactHttpHandler({
    getCore: () => core,
    authenticator: {
      async authenticate(req: Request) {
        const auth = req.headers.get("Authorization");
        if (auth === "Bearer test-token") {
          return {
            actorId: 1,
            identityId: "tester",
            credentialId: "cred-1",
            scopes: ["artifacts:read", "artifacts:write", "artifacts:share"],
          };
        }
        return null;
      },
    },
    getShareByTokenHash: async tokenHash => {
      for (const s of shares.values()) {
        if (s.tokenHash === tokenHash) return { identityId: "tester", share: s };
      }
      return undefined;
    },
    getShareArtifactContent: async (_identityId, artifactId) => {
      if (artifactId === savedRecord.id) {
        return {
          record: savedRecord,
          stream: (async function* () {
            yield new TextEncoder().encode("Hello world!\n");
          })(),
        };
      }
      return undefined;
    },
    verifyPassword: async (pwd, salt, expectedHash) => {
      const computed = createHash("sha256").update(pwd + salt).digest("hex");
      return computed === expectedHash;
    },
    hashToken: async token => createHash("sha256").update(token).digest("hex"),
    now: () => "2026-10-06T12:05:00.000Z",
    ...overrides,
  });

  const client = new ArtifactHttpClient({
    baseUrl: "https://barry.local",
    identityId: "tester",
    token: "test-token",
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      return handler(request);
    },
  });

  return { handler, client, getRecord: () => savedRecord, shares, core };
}

describe("Artifacts HTTP Router and Client", () => {
  it.each(["GET", "HEAD"])("requests metadata without reading a blob for share previews (%s)", async method => {
    const next = vi.fn(async () => ({ done: true as const, value: undefined }));
    const release = vi.fn(async () => ({ done: true as const, value: undefined }));
    const getContent = vi.fn<NonNullable<ArtifactHttpServerOptions["getShareArtifactContent"]>>(async () => ({
      record: initialRecord(), stream: { [Symbol.asyncIterator]: () => ({ next, return: release }) },
    }));
    const { client, handler } = setupHttpEnv({ getShareArtifactContent: getContent });
    const share = await client.createShare({ artifactId: "artifact-http-1", expiresInSeconds: 3600 });
    const response = await handler(new Request(`https://barry.local/p/tester/${share.token}`, { method }));
    expect(response.status).toBe(200);
    expect(getContent.mock.calls[0]).toEqual(["tester", "artifact-http-1", { metadataOnly: true, signal: expect.any(AbortSignal) }]);
    expect(next).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    if (method === "HEAD") expect(response.body).toBeNull();
    else expect((await response.json()).artifact.id).toBe("artifact-http-1");
  });

  it("requests no blob stream for raw share HEAD", async () => {
    const release = vi.fn(async () => ({ done: true as const, value: undefined }));
    const next = vi.fn(async () => ({ done: true as const, value: undefined }));
    const getContent = vi.fn<NonNullable<ArtifactHttpServerOptions["getShareArtifactContent"]>>(async () => ({ record: initialRecord(), stream: { [Symbol.asyncIterator]: () => ({ next, return: release }) } }));
    const { client, handler } = setupHttpEnv({ getShareArtifactContent: getContent });
    const share = await client.createShare({ artifactId: "artifact-http-1", expiresInSeconds: 3600 });
    const response = await handler(new Request(`https://barry.local/p/tester/${share.token}/raw`, { method: "HEAD" }));
    expect(response.body).toBeNull();
    expect(response.headers.get("Content-Length")).toBe("13");
    expect(getContent.mock.calls[0]?.[2]).toMatchObject({ metadataOnly: true });
    expect(next).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
  });

  it.each(["cancel", "abort", "error"])("releases a raw share stream on %s", async ending => {
    const release = vi.fn(async () => ({ done: true as const, value: undefined }));
    const next = vi.fn(async () => {
      if (ending === "error") throw new Error("blob read failed");
      return { done: false as const, value: new Uint8Array([1]) };
    });
    const { client, handler } = setupHttpEnv({ getShareArtifactContent: async () => ({
      record: initialRecord(), stream: { [Symbol.asyncIterator]: () => ({ next, return: release }) },
    }) });
    const share = await client.createShare({ artifactId: "artifact-http-1", expiresInSeconds: 3600 });
    const controller = new AbortController();
    const response = await handler(new Request(`https://barry.local/p/tester/${share.token}/raw`, { signal: controller.signal }));
    const reader = response.body!.getReader();
    if (ending === "error") await expect(reader.read()).rejects.toThrow("blob read failed");
    else {
      await reader.read();
      if (ending === "cancel") await reader.cancel();
      else { controller.abort(new Error("request aborted")); await expect.poll(() => release.mock.calls.length).toBe(1); }
    }
    expect(release).toHaveBeenCalledOnce();
  });

  it("reads authenticated HEAD metadata without opening a blob stream", async () => {
    const { handler, core } = setupHttpEnv();
    const stream = vi.spyOn(core, "streamContent");
    const response = await handler(new Request("https://barry.local/api/v1/identities/tester/artifacts/artifact-http-1/content", {
      method: "HEAD", headers: { Authorization: "Bearer test-token" },
    }));
    expect(response.status).toBe(200); expect(response.body).toBeNull();
    expect(response.headers.get("Content-Length")).toBe("13");
    expect(stream).not.toHaveBeenCalled();
  });

  it("responds to /health with ok status", async () => {
    const { handler } = setupHttpEnv();
    const res = await handler(new Request("https://barry.local/health"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(json.timestamp).toBeTruthy();
  });

  it("reads and lists artifacts via HTTP client", async () => {
    const { client } = setupHttpEnv();
    const artifact = await client.read("artifact-http-1");
    expect(artifact.id).toBe("artifact-http-1");
    expect(artifact.metadata.title).toBe("Initial Report");

    const list = await client.list();
    expect(list.items.length).toBe(1);
    expect(list.items[0].id).toBe("artifact-http-1");
  });

  it("updates artifact metadata and prevents stale edits", async () => {
    const { client } = setupHttpEnv();
    const updated = await client.updateMetadata({
      id: "artifact-http-1",
      expectedRevision: 1,
      title: "Updated Title",
      tags: ["updated"],
    });
    expect(updated.metadata.title).toBe("Updated Title");
    expect(updated.metadata.revision).toBe(2);

    // Stale edit with revision 1 fails with conflict
    await expect(client.updateMetadata({
      id: "artifact-http-1",
      expectedRevision: 1,
      title: "Stale Edit",
    })).rejects.toMatchObject({ code: "conflict" });
  });

  it("streams artifact content through HTTP client", async () => {
    const { client } = setupHttpEnv();
    const { record, stream } = await client.streamContent("artifact-http-1");
    expect(record.id).toBe("artifact-http-1");

    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    expect(text).toBe("Hello world!\n");
  });

  it("creates, updates, and accesses public shares with password verification", async () => {
    const { client, handler } = setupHttpEnv();
    const share = await client.createShare({
      artifactId: "artifact-http-1",
      expiresInSeconds: 3600,
      password: "secret-share-pwd",
    });

    expect(share.token).toBeTruthy();
    expect(share.metadata.hasPassword).toBe(true);

    // Public preview route without password returns 401
    const previewNoPwd = await handler(new Request(`https://barry.local/p/tester/${share.token}`));
    expect(previewNoPwd.status).toBe(401);
    const queryPassword = await handler(new Request(`https://barry.local/p/tester/${share.token}?password=secret-share-pwd`));
    expect(queryPassword.status).toBe(401);

    // Public preview route with invalid password returns 403
    const previewBadPwd = await handler(new Request(`https://barry.local/p/tester/${share.token}`, {
      headers: { "X-Artifact-Password": "wrong" },
    }));
    expect(previewBadPwd.status).toBe(403);

    // Public preview route with valid password returns metadata
    const previewGoodPwd = await handler(new Request(`https://barry.local/p/tester/${share.token}`, {
      headers: { "X-Artifact-Password": "secret-share-pwd" },
    }));
    expect(previewGoodPwd.status).toBe(200);
    const previewJson = await previewGoodPwd.json();
    expect(previewJson.artifact.id).toBe("artifact-http-1");
    expect(Object.keys(previewJson.artifact).sort()).toEqual(["createdAt", "filename", "id", "kind", "mimeType", "size", "title"]);
    expect(Object.keys(previewJson.share)).toEqual(["expiresAt"]);
    expect(previewJson.artifact.filename).toBe("report.md");
    expect(previewJson.artifact.mimeType).toBe("text/markdown");

    // Public raw route with valid password streams download
    const rawGoodPwd = await handler(new Request(`https://barry.local/p/tester/${share.token}/raw`, {
      headers: { "X-Artifact-Password": "secret-share-pwd" },
    }));
    expect(rawGoodPwd.status).toBe(200);
    expect(rawGoodPwd.headers.get("Content-Type")).toBe("text/markdown");
    expect(rawGoodPwd.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const rawText = await rawGoodPwd.text();
    expect(rawText).toBe("Hello world!\n");
  });

  it("denies unauthenticated requests and requests with insufficient scopes", async () => {
    const { handler } = setupHttpEnv();

    // No auth header -> 401
    const unauth = await handler(new Request("https://barry.local/api/v1/identities/tester/artifacts/artifact-http-1"));
    expect(unauth.status).toBe(401);

    // Client with wrong token -> 401
    const wrongClient = new ArtifactHttpClient({
      baseUrl: "https://barry.local",
      identityId: "tester",
      token: "wrong-token",
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init)),
    });
    await expect(wrongClient.read("artifact-http-1")).rejects.toMatchObject({ code: "forbidden" });
  });
});

it("passes the path identity to the share lookup", async () => {
  let received: string | undefined;
  const handler = createArtifactHttpHandler({
    getCore: () => { throw new Error("unused"); },
    hashToken: async token => token,
    getShareByTokenHash: async (_hash, identity) => { received = identity; return undefined; },
    getShareArtifactContent: async () => undefined,
  });
  expect((await handler(new Request("https://barry.local/p/path-identity/token"))).status).toBe(404);
  expect(received).toBe("path-identity");
});
