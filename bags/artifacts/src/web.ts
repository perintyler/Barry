import { createServer } from "node:http";
import { Readable } from "node:stream";
import { once } from "node:events";
import { handleSignIn, isAuthorized, SIGN_IN_PATH } from "@barry-rocks/sdk/auth";
import { listenOnAssignedPort } from "@barry-rocks/sdk/services";
import { createLogger } from "@barry-rocks/sdk/logging";
import { createLocalArtifactHttpHandler } from "./local/http.js";

const secret = process.env.BARRY_SECRET ?? "";
const handler = createLocalArtifactHttpHandler();
const logger = createLogger("artifacts");

export const server = createServer(async (req, res) => {
  const abort = new AbortController();
  res.on("close", () => { if (!res.writableFinished) abort.abort(); });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (await handleSignIn(req, res, secret, "Artifacts")) return;
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/" && (req.method === "GET" || req.method === "HEAD")) {
      if (!isAuthorized(req, secret)) {
        res.writeHead(303, { Location: SIGN_IN_PATH, "Cache-Control": "no-store" });
        res.end(); return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>Barry artifacts</title><body><p>This browser is signed in to Barry's artifacts.</p><p>Share links open at <code>/p/…</code>.</p><p>The owner API is at <code>/api/v1/identities/&lt;identity&gt;/artifacts</code>.</p></body></html>");
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      else if (value !== undefined) headers.set(name, value);
    }
    const method = req.method ?? "GET";
    const init: RequestInit & { duplex: "half" } = {
      method, headers, signal: abort.signal, duplex: "half",
    };
    if (method !== "GET" && method !== "HEAD") init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
    const request = new Request(new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`), init);
    const response = await handler(request, { owner: isAuthorized(req, secret) });
    res.statusCode = response.status;
    response.headers.forEach((value, name) => res.setHeader(name, value));
    if (method === "HEAD") { await response.body?.cancel(); res.end(); return; }
    reader = response.body?.getReader();
    if (reader) {
      while (!abort.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(value)) await once(res, "drain", { signal: abort.signal });
      }
    }
    res.end();
  } catch {
    if (!res.headersSent && !res.destroyed) {
      res.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: { code: "internal_error", message: "Artifact service error" } }));
    } else res.destroy();
  } finally {
    if (abort.signal.aborted) await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
});

if (!process.env.VITEST) {
  listenOnAssignedPort(server).then(
    () => logger.info("Artifacts web listening"),
    error => { logger.error("Artifacts web failed to start", { error }); process.exit(1); },
  );
}
