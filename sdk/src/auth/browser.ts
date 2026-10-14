/**
 * A browser's way into a Barry service: the instance secret, entered once on a
 * sign-in page and exchanged for a cookie.
 *
 * A page cannot carry the secret the way an app does. Handing it to the page
 * over an unauthenticated route (what questions' `/config` did) gives it to
 * any process or page that can reach that route; embedding it in the page
 * does the same. So the person types it once, and the service answers with an
 * HttpOnly, SameSite=Strict cookie: script on the page cannot read it, and no
 * other site's requests carry it.
 *
 * The cookie holds a value derived from the secret, never the secret itself,
 * and the service keeps no session state: rotating BARRY_SECRET signs every
 * browser out.
 *
 * Framework-neutral: plain node:http types, which express's request and
 * response extend.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { requestCredential } from "./credentials.js";

export const SESSION_COOKIE = "barry_session";
export const SIGN_IN_PATH = "/sign-in";

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;
const THIRTY_DAYS_MS = THIRTY_DAYS_SECONDS * 1000;
/** The form posts one field; anything much longer is not a secret. */
const MAX_FORM_BYTES = 4096;

function sameValue(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The signed body of the session cookie.
 *
 * Issued-at and expiry are part of the HMAC input, not just the client-visible
 * `Max-Age`: a cookie that encodes its own lifetime inside the signature cannot
 * be replayed past its expiry, and the value is no longer a single static
 * derivative of the secret that is equivalent to the secret until rotation.
 *
 * Shape: `v2.<issuedAtMs>.<expiresAtMs>.<base64url HMAC>`. The HMAC covers the
 * domain tag plus both timestamps, so neither can be edited without the secret.
 */
const TOKEN_VERSION = "v2";

function signSession(secret: string, issuedAtMs: number, expiresAtMs: number): string {
  const body = `${TOKEN_VERSION}.${issuedAtMs}.${expiresAtMs}`;
  const mac = createHmac("sha256", secret)
    .update("barry browser session v1\0")
    .update(body)
    .digest("base64url");
  return `${body}.${mac}`;
}

/**
 * What the session cookie holds for an instance whose secret is `secret`.
 *
 * `now`/`lifetimeMs` are injectable for tests and for callers that want a
 * shorter window; by default a browser stays signed in for 30 days.
 */
export function sessionToken(secret: string, now: number = Date.now(), lifetimeMs: number = THIRTY_DAYS_MS): string {
  return signSession(secret, now, now + lifetimeMs);
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at !== -1 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

/**
 * Whether the request carries the secret as a bearer token or `x-barry-secret`.
 *
 * Delegates to `requestCredential`, the single parser the API server already
 * uses: it rejects duplicate `Authorization`/`x-barry-secret` headers (which
 * Node can otherwise silently collapse) and enforces a token charset. Keeping
 * two parsers for "does this request carry the secret" is exactly the drift the
 * auth code warns against.
 */
export function carriesSecret(req: IncomingMessage, secret: string): boolean {
  if (!secret) return false;
  const presented = requestCredential(req);
  return presented !== null && sameValue(presented, secret);
}

/**
 * Whether the request carries a session cookie a sign-in with `secret` issued
 * that has not yet expired. The embedded timestamps are re-signed and compared,
 * and the expiry is checked against `now`.
 */
export function hasBrowserSession(req: IncomingMessage, secret: string, now: number = Date.now()): boolean {
  if (!secret) return false;
  const presented = cookieValue(req.headers.cookie, SESSION_COOKIE);
  if (presented === undefined) return false;
  const parts = presented.split(".");
  if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) return false;
  const issuedAtMs = Number(parts[1]);
  const expiresAtMs = Number(parts[2]);
  if (!Number.isSafeInteger(issuedAtMs) || !Number.isSafeInteger(expiresAtMs)) return false;
  if (expiresAtMs <= now || issuedAtMs > now) return false;
  return sameValue(presented, signSession(secret, issuedAtMs, expiresAtMs));
}

/** The secret, from an app, or a signed-in browser's cookie. Nothing else counts. */
export function isAuthorized(req: IncomingMessage, secret: string): boolean {
  return carriesSecret(req, secret) || hasBrowserSession(req, secret);
}

function signInPage(title: string, failed: boolean): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · ${title}</title>
<style>body{font:15px system-ui,sans-serif;max-width:26rem;margin:15vh auto;padding:0 1rem}
input,button{font:inherit;padding:.5rem;width:100%;box-sizing:border-box;margin-top:.5rem}
.err{color:#b00020}</style></head>
<body><h1>${title}</h1>
<form method="post" action="${SIGN_IN_PATH}">
<label for="secret">Barry secret</label>
<input id="secret" name="secret" type="password" autocomplete="current-password" autofocus required>
${failed ? '<p class="err">That is not this instance\'s secret.</p>' : ""}
<button type="submit">Sign in</button>
</form>
<p>Your instance's <code>BARRY_SECRET</code>. This browser stays signed in for 30 days.</p>
</body></html>`;
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_FORM_BYTES) break;
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Serve `GET /sign-in` (the form) and `POST /sign-in` (the exchange). Returns
 * false for any other request, so a server calls it first and carries on.
 *
 * A right secret sets the cookie and redirects to `/`; a wrong one re-renders
 * the form with a 401. The cookie is `Secure` when the request reached the
 * provider over https, so a page reached over the tunnel never sends it in
 * the clear, and plain http on this Mac still works.
 */
export async function handleSignIn(
  req: IncomingMessage,
  res: ServerResponse,
  secret: string,
  title: string,
): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://service.invalid").pathname;
  if (path !== SIGN_IN_PATH) return false;

  const html = (status: number, body: string) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
  };

  if (req.method === "GET") {
    html(200, signInPage(title, false));
    return true;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "GET, POST" });
    res.end();
    return true;
  }

  const presented = (await readForm(req)).get("secret") ?? "";
  if (!secret || !sameValue(presented, secret)) {
    html(401, signInPage(title, true));
    return true;
  }

  const secure = req.headers["x-forwarded-proto"] === "https";
  const cookie = [
    `${SESSION_COOKIE}=${sessionToken(secret)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${THIRTY_DAYS_SECONDS}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
  res.writeHead(303, { "set-cookie": cookie, location: "/", "cache-control": "no-store" });
  res.end();
  return true;
}
