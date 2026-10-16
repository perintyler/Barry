import type { IncomingMessage, ServerResponse } from "node:http";
import { carriesSecret } from "@barry-rocks/sdk/auth";
import { z } from "zod";

type Upstream = (path: string, init?: { method?: string; body?: unknown }) => Promise<{ status: number; body: unknown }>;
const selection = z.string().min(1).max(200);
const workId = z.string().regex(/^work_[a-f0-9]{32}$/);
const start = z.strictObject({ session_id: selection, action: z.string().max(200).regex(/^[^:@]+:[^:@]+$/), request_id: z.uuid(), idempotency_key: selection, inputs: z.record(z.string(), z.json()), recovery_epoch: z.uuid().optional() });
const stop = z.strictObject({ request_id: z.uuid(), expected_revision: z.number().int().positive(), reason: z.string().trim().min(1).max(2000) });
const sessions = z.object({ sessions: z.array(z.object({ id: selection, name: z.string().nullable(), identity_id: z.number().int().positive(), ended: z.boolean() })) });

function send(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body));
}
function body(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0, done = false;
    req.on("data", (bytes: Buffer) => {
      if (done) return; size += bytes.length;
      if (size > 1_000_000) { done = true; reject(new Error("Input exceeds the request limit.")); return; }
      chunks.push(bytes);
    });
    req.on("end", () => { if (done) return; done = true; try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (error) { reject(error); } });
    req.on("error", error => { if (!done) { done = true; reject(error); } });
  });
}
function query(url: URL, key?: string) {
  if ([...url.searchParams.keys()].some(name => name !== "session_id") || url.searchParams.getAll("session_id").length !== 1) throw new Error("Select one session.");
  return new URLSearchParams({ session_id: selection.parse(url.searchParams.get("session_id")), ...(key ? { key } : {}) });
}
function browserWrite(req: IncomingMessage, secret: string) {
  if ((req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase() !== "application/json") return false;
  if (carriesSecret(req, secret)) return true;
  try {
    const configured = process.env.BARRY_ACTIONS_ORIGIN;
    const expected = new URL(configured || `${"encrypted" in req.socket && req.socket.encrypted ? "https" : "http"}://${req.headers.host}`);
    if (!["http:", "https:"].includes(expected.protocol) || expected.username || expected.password || expected.pathname !== "/" || expected.search || expected.hash) return false;
    return req.headers.origin === expected.origin && req.headers["sec-fetch-site"] !== "cross-site";
  } catch { return false; }
}

/** Authenticated, explicitly selected work only. No arbitrary upstream path or actor passes through. */
export async function identityWorkRoute(req: IncomingMessage, res: ServerResponse, url: URL, secret: string, call: Upstream): Promise<boolean> {
  const rawPath = (req.url ?? "").split("?")[0];
  if (!rawPath.startsWith("/api/work/")) return false;
  if (rawPath !== url.pathname) { send(res, { error: "InvalidInputs", message: "Use a canonical work endpoint.", admission_disposition: "refused" }, 422); return true; }
  const method = req.method ?? "GET";
  if (method === "POST" && !browserWrite(req, secret)) { send(res, { error: "Cross-origin or non-JSON write refused." }, 403); return true; }
  let forwarded = false;
  try {
    let path: string, init: { method?: string; body?: unknown } | undefined;
    if (url.pathname === "/api/work/sessions" && method === "GET") {
      if (url.search) throw new Error("Session listing takes no query parameters.");
      forwarded = true; const reply = await call("/actions/work-sessions");
      if (reply.status !== 200) send(res, reply.body, reply.status);
      else send(res, sessions.parse(reply.body));
      return true;
    } else if (url.pathname === "/api/work/catalog" && method === "GET") path = `/actions/work-catalog?${query(url)}`;
    else if (url.pathname === "/api/work/start" && method === "POST") {
      if (url.search) throw new Error("Admission does not take query parameters.");
      const { session_id, action, ...intent } = start.parse(await body(req));
      path = `/actions/${encodeURIComponent(action)}/work-start?${new URLSearchParams({ session_id })}`; init = { method: "POST", body: intent };
    } else {
      const operation = url.pathname.match(/^\/api\/work\/operations\/([^/]+)$/);
      const item = url.pathname.match(/^\/api\/work\/items\/([^/]+)(?:\/(result|stop))?$/);
      if (operation && method === "GET") {
        const key = selection.parse(decodeURIComponent(operation[1]));
        if (key === "." || key === "..") throw new Error("Invalid operation key.");
        path = `/actions/work-operations/${encodeURIComponent(key)}?${query(url)}`;
      }
      else if (item && ((method === "GET" && item[2] !== "stop") || (method === "POST" && item[2] === "stop"))) {
        const id = workId.parse(decodeURIComponent(item[1])); path = `/actions/work-items/${id}${item[2] ? `/${item[2]}` : ""}?${query(url)}`;
        if (method === "POST") init = { method, body: stop.parse(await body(req)) };
      } else { send(res, { error: "Not found" }, 404); return true; }
    }
    forwarded = true; const reply = await call(path, init); send(res, reply.body, reply.status);
  } catch {
    send(res, forwarded ? { error: "Work request is unconfirmed. Preserve the selected session, request ID, key and input.", retryable: true } : { error: "InvalidInputs", message: "Select one valid session and provide a valid work request.", admission_disposition: "refused" }, forwarded ? 503 : 422);
  }
  return true;
}
