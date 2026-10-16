import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeRegistry } from "@barry-rocks/sdk/internal/nodes";
import { barryStoresDir } from "@barry-rocks/sdk/services";
import { withStoreContext } from "@barry-rocks/sdk/internal/stores";
import { createModels, installModels, defineVendor } from "@barry-rocks/sdk/adapters/models";

import { getSession } from "@barry-rocks/sessions-bag/client";
import { searchCollection } from "@barry-rocks/embeddings-bag/store";
import { closeDb } from "@barry-rocks/embeddings-bag/db";
import { getSessionsSqlite, closeSessionsDb } from "@barry-rocks/sessions-bag/store/sessions-db";
import { runSweep } from "./sweep.js";
import { vectorSearchMessagesTool } from "./tools.js";
import { COLLECTION, WATERMARK_KEY } from "./sweep-core.js";


const diagnosticError = vi.hoisted(() => vi.fn());
vi.mock("@barry-rocks/sdk/logging", async original => {
  const logging = await original<typeof import("@barry-rocks/sdk/logging")>();
  return { ...logging, createLogger(...args: Parameters<typeof logging.createLogger>) {
    const logger = logging.createLogger(...args);
    if (args[0] !== "session-vector-search" && args[0] !== "sessions.search") return logger;
    return { ...logger, error(...messages: Parameters<typeof logger.error>) {
      diagnosticError(...messages);
      logger.error(...messages);
    } };
  } };
});
beforeEach(() => diagnosticError.mockClear());

let home: string;
let identityA: string;
let identityB: string;
const textA = "The first identity repaired the broken deployment with a migration.";
const textB = "The second identity discussed recipes for a birthday celebration.";

function seed(id: string, identity: number, text: string): void {
  const db = getSessionsSqlite();
  db.prepare("INSERT INTO sessions (id,user_id,identity_id,created_at,message_count,metadata) VALUES (?,7,?,'2026-01-01T00:00:00.000Z',1,'{}')").run(id, identity);
  db.prepare("INSERT INTO messages (id,session_id,type,sequence,role,content,content_text,metadata,created_at) VALUES (?,?,'message',1,'user',?,?,'{}','2026-01-01T00:00:00.000Z')").run(`${id}-message`, id, JSON.stringify([{ type: "text", text }]), text);
}

beforeEach(() => {
  closeSessionsDb();
  closeDb();
  home = mkdtempSync(join(tmpdir(), "barry-search-sweep-"));
  vi.stubEnv("BARRY_HOME", home);
  vi.stubEnv("BARRY_SESSIONS_DB", "");
  vi.stubEnv("BARRY_EMBEDDINGS_DB", undefined);
  mkdirSync(barryStoresDir(), { recursive: true });
  writeFileSync(join(barryStoresDir(), "active.json"), JSON.stringify({ id: "search-test" }));
  const nodes = new NodeRegistry();
  try { identityA = nodes.identityId(11); identityB = nodes.identityId(12); }
  finally { nodes.close(); }
  withStoreContext({ identity: identityA }, () => seed("session-a", 11, textA));
  withStoreContext({ identity: identityB }, () => seed("session-b", 12, textB));
  installModels(createModels([defineVendor({
    id: "ollama", label: "Ollama", baseUrl: "http://ollama.test", credential: null,
    models: [{ id: "nomic-embed-text", label: "Nomic", kind: "embedding" }],
    embedding: (model) => ({ ref: `ollama/${model}`, embed: async ({ input }) => ({ vectors: input.map(() => [1, 0]), servedModel: model }) }),
  })], { env: {} }));
});
afterEach(() => {
  closeSessionsDb();
  closeDb();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("barry.models.v1")];
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

describe("sweep store routing", () => {
  it("indexes each partition in its identity's embeddings store and moves its watermark", async () => {
    expect(await runSweep({ ignoreLock: true })).toMatchObject({ sessionsEmbedded: 2, messagesEmbedded: 2, failed: 0 });
    for (const [identity, session, text] of [[identityA, "session-a", textA], [identityB, "session-b", textB]]) {
      await withStoreContext({ identity }, async () => {
        expect(searchCollection(COLLECTION, [1, 0]).map((hit) => hit.text)).toEqual([text]);
        expect((await getSession(session))?.metadata?.[WATERMARK_KEY]).toBe(1);
      });
    }
    expect(searchCollection(COLLECTION, [1, 0])).toEqual([]);
    const answer = await withStoreContext({ identity: identityA }, () => vectorSearchMessagesTool.handler({ query: "paraphrase", limit: 10, session_id: undefined, role: undefined }));
    expect(answer).toContain("[meaning] session-a");
    expect(answer).toContain(textA);
    expect(answer).not.toContain("session-b");
    expect(answer).not.toContain(textB);
  });

  it("keeps sessions without an identity in the node store", async () => {
    seed("node-session", 0, "An unscoped session also needs its messages indexed in the node store.");
    expect(await runSweep({ ignoreLock: true })).toMatchObject({ sessionsEmbedded: 3, failed: 0 });
    expect(searchCollection(COLLECTION, [1, 0]).map((hit) => hit.metadata?.sessionId)).toEqual(["node-session"]);
    expect((await getSession("node-session"))?.metadata?.[WATERMARK_KEY]).toBe(1);
  });

  it("counts an ambiguous location as failed without advancing either copy", async () => {
    withStoreContext({ identity: identityB }, () => seed("session-a", 11, textA));

    const result = await runSweep({ ignoreLock: true });
    expect(result.failed).toBeGreaterThan(0);
    expect(diagnosticError).toHaveBeenCalledWith("sessions.embedding_session_failed", expect.objectContaining({ detail: expect.stringContaining("Ambiguous Session location") }));
    for (const identity of [identityA, identityB]) {
      await withStoreContext({ identity }, async () => {
        expect((await getSession("session-a"))?.metadata?.[WATERMARK_KEY]).toBeUndefined();
        expect(searchCollection(COLLECTION, [1, 0]).some((hit) => hit.metadata?.sessionId === "session-a")).toBe(false);
      });
    }
  });
});
