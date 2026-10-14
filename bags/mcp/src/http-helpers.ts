/**
 * Small HTTP/env helpers lifted out of application.ts: an env projector and the
 * in-process rate limiter. Behaviour is byte-faithful; the limiter takes `log`
 * as a parameter rather than closing over it.
 */
import express from "express";
import type { Logger } from "@barry-rocks/sdk/logging";

/** Project the named keys out of an env-like record, dropping undefined values. */
export function pickEnv(
  env: Record<string, string | undefined>,
  names: string[],
): Record<string, string> {
  return Object.fromEntries(
    names
      .filter((name) => env[name] !== undefined)
      .map((name) => [name, env[name] as string]),
  );
}

// Simple in-process rate limiter (no external deps)
export function createRateLimiter(
  windowMs: number,
  maxRequests: number,
  log: Logger,
) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    let entry = hits.get(ip);

    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(ip, entry);
    }

    entry.count++;
    if (entry.count > maxRequests) {
      // Logged because a rate limiter you cannot observe is one you cannot tune,
      // and its symptom — tools that intermittently fail to answer — looks
      // nothing like rate limiting from the client side. Every 429 here was
      // previously invisible: no request logger, no counter, no line.
      log.warn("mcp.rate_limited", {
        ip,
        count: entry.count,
        limit: maxRequests,
        windowMs,
        barrySessionId:
          typeof req.query.sessionId === "string"
            ? req.query.sessionId
            : undefined,
      });
      res.status(429).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Rate limit exceeded" },
        id: null,
      });
      return;
    }

    next();
  };
}
