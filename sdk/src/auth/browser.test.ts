import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SESSION_COOKIE, handleSignIn, hasBrowserSession, isAuthorized, sessionToken } from "./browser.js";

const SECRET = "barry_browser_test_secret";

/** A service with one protected route, the way a bag's web server uses this module. */
let server: Server;
let base: string;

beforeEach(async () => {
  server = createServer(async (req, res) => {
    if (await handleSignIn(req, res, SECRET, "Test")) return;
    if (!isAuthorized(req, SECRET)) {
      res.writeHead(401);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: "private" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function signIn(secret: string, headers: Record<string, string> = {}) {
  return fetch(`${base}/sign-in`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ secret }).toString(),
  });
}

describe("browser sign-in", () => {
  it("refuses a request with no secret and no cookie", async () => {
    expect((await fetch(`${base}/api/data`)).status).toBe(401);
  });

  it("serves the sign-in form without a secret", async () => {
    const page = await fetch(`${base}/sign-in`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('name="secret"');
  });

  it("exchanges the right secret for an HttpOnly, SameSite=Strict cookie that is not the secret", async () => {
    const res = await signIn(SECRET);
    expect(res.status).toBe(303);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SESSION_COOKIE}=v2.`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain(SECRET);
    expect(cookie).not.toContain("Secure");

    const pair = cookie.split(";")[0];
    const data = await fetch(`${base}/api/data`, { headers: { cookie: pair } });
    expect(data.status).toBe(200);
  });

  it("marks the cookie Secure when the request reached the provider over https", async () => {
    const res = await signIn(SECRET, { "x-forwarded-proto": "https" });
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });

  it("refuses a wrong secret, and a cookie minted from one", async () => {
    const res = await signIn("barry_not_it");
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();

    const forged = `${SESSION_COOKIE}=${sessionToken("barry_not_it")}`;
    expect((await fetch(`${base}/api/data`, { headers: { cookie: forged } })).status).toBe(401);
  });

  it("still admits an app that sends the secret as a bearer token", async () => {
    const res = await fetch(`${base}/api/data`, { headers: { authorization: `Bearer ${SECRET}` } });
    expect(res.status).toBe(200);
  });
});

describe("session cookie carries issued-at and expiry in the HMAC (SDK-6)", () => {
  function reqWithCookie(value: string) {
    return { headers: { cookie: `${SESSION_COOKIE}=${value}` } } as import("node:http").IncomingMessage;
  }

  it("accepts a fresh token and rejects it once expired", () => {
    const now = 1_000_000_000_000;
    const token = sessionToken(SECRET, now, 1000); // 1s lifetime
    expect(hasBrowserSession(reqWithCookie(token), SECRET, now)).toBe(true);
    // The expiry is inside the signed body, so a replay past it fails without
    // the server keeping any state.
    expect(hasBrowserSession(reqWithCookie(token), SECRET, now + 2000)).toBe(false);
  });

  it("rejects a token whose embedded expiry was edited", () => {
    const now = 1_000_000_000_000;
    const token = sessionToken(SECRET, now, 1000);
    const parts = token.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${Number(parts[2]) + 10_000_000}.${parts[3]}`;
    // Pushing the expiry out requires re-signing, which needs the secret.
    expect(hasBrowserSession(reqWithCookie(tampered), SECRET, now)).toBe(false);
  });

  it("two sign-ins produce different cookie values (issued-at differs)", () => {
    const a = sessionToken(SECRET, 1_000_000_000_000);
    const b = sessionToken(SECRET, 1_000_000_000_001);
    expect(a).not.toBe(b);
  });
});

describe("carriesSecret delegates to requestCredential (SDK-6)", () => {
  function req(headers: Record<string, string>, rawHeaders: string[] = []): import("node:http").IncomingMessage {
    return { headers, rawHeaders } as import("node:http").IncomingMessage;
  }

  it("accepts a single bearer token and an x-barry-secret header", async () => {
    const { carriesSecret } = await import("./browser.js");
    expect(carriesSecret(req({ authorization: `Bearer ${SECRET}` }, ["authorization", `Bearer ${SECRET}`]), SECRET)).toBe(true);
    expect(carriesSecret(req({ "x-barry-secret": SECRET }, ["x-barry-secret", SECRET]), SECRET)).toBe(true);
  });

  it("refuses duplicate authorization headers the way requestCredential does", async () => {
    const { carriesSecret } = await import("./browser.js");
    const raw = ["authorization", `Bearer ${SECRET}`, "authorization", `Bearer ${SECRET}`];
    expect(carriesSecret(req({ authorization: `Bearer ${SECRET}` }, raw), SECRET)).toBe(false);
  });

  it("refuses the wrong secret", async () => {
    const { carriesSecret } = await import("./browser.js");
    expect(carriesSecret(req({ authorization: "Bearer nope" }, ["authorization", "Bearer nope"]), SECRET)).toBe(false);
  });
});
