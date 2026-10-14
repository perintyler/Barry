/**
 * Who may call a Barry service: whoever carries the instance secret.
 *
 * A request's source address says nothing about who sent it. Every hosting
 * provider (a local name, a private or a public tunnel) connects from
 * 127.0.0.1, so trusting loopback trusted the internet the moment a tunnel
 * pointed at a service, and trusting a private network's address range trusted
 * every device on it. The address-based paths are gone; the secret is the only
 * way in.
 */
import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual, randomBytes } from "crypto";
import { requestCredential } from "./credentials.js";

/** Constant-time comparison that also refuses a length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  const maxLength = Math.max(aBuffer.length, bBuffer.length);
  const paddedA = Buffer.alloc(maxLength);
  const paddedB = Buffer.alloc(maxLength);
  aBuffer.copy(paddedA);
  bBuffer.copy(paddedB);
  return timingSafeEqual(paddedA, paddedB) && aBuffer.length === bBuffer.length;
}

/** Generate a new BARRY_SECRET token. */
export function generateBarrySecret(): string {
  return `barry_${randomBytes(24).toString("base64url")}`;
}

/** Whether the request carries the instance secret, as a bearer token or `x-barry-secret`. */
export function hasValidSecret(req: Request): boolean {
  const credential = requestCredential(req);
  return credential !== null && verifyInstallationCredential(credential);
}

export function verifyInstallationCredential(credential: string): boolean {
  // Revalidation must observe rotation in the running process, not an import-time snapshot.
  const secret = process.env.BARRY_SECRET;
  return Boolean(secret && secret.length <= 4096 && credential && credential.length <= 4096 && safeEqual(credential, secret));
}

/** Whether an HTTP request may proceed: it carries the secret. Nothing else counts. */
export function isAuthenticated(req: Request): boolean {
  return hasValidSecret(req);
}

/** Whether a WebSocket upgrade may proceed, given the secret it presented. */
export function isAuthenticatedWs(secret: string | undefined): boolean {
  return secret !== undefined && verifyInstallationCredential(secret);
}

/**
 * Secret-only middleware. Skips /health. Returns 401 on failure, and 500 when
 * the service itself has no secret to compare against.
 */
export function barryAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.path === "/health") return next();

  if (!process.env.BARRY_SECRET) {
    res.status(500).json({ ok: false, error: "Server misconfigured: BARRY_SECRET not set" });
    return;
  }

  if (hasValidSecret(req)) return next();

  res.status(401).json({ ok: false, error: "Unauthorized: Missing or invalid BARRY_SECRET" });
}



export * from "./http.js";
export * from "./credential.js";
export * from "./principal.js";
export * from "./pairing.js";
export * from "./workflow-actor.js";
export * from "./workflow-session-credential.js";
