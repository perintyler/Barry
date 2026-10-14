/**
 * Request and error logging for a Barry HTTP service.
 *
 * Lives here, beside `applyBaseMiddleware` and `applyAuth`, because request
 * logging is a SERVICE concern rather than a logging-format concern — the
 * format and emitter are in `@barry-rocks/sdk/logging`, the store in the logs
 * bag.
 * The global `Express.Request` augmentation below can only be declared in one
 * package without conflicting, and it belongs with the package that already
 * owns this service's Express surface.
 *
 * NOTE the deliberate shape difference from its neighbours: `applyBaseMiddleware(app)`
 * and `applyAuth(app)` APPLY themselves to the app, while `createRequestLogger(name, opts)`
 * RETURNS a handler for the caller to `app.use()` itself. That asymmetry is the
 * point — it is what lets each service choose the POSITION, and the three
 * services deliberately disagree:
 *
 *   - bags/sessions/api and bags/identities mount it BETWEEN applyBaseMiddleware
 *     and applyAuth, so unauthenticated traffic is logged.
 *   - engine mounts it AFTER barryAuth, so unauthenticated probes do not fill
 *     the MCP server's stderr (which is also its error log).
 *
 * Folding this into `applyBaseMiddleware` would silently pick one of those and
 * change the other's behaviour. Do not.
 */
import type { Request, Response, NextFunction, RequestHandler, ErrorRequestHandler } from "express";
import { getLoggerFactory, type Logger } from "./logging.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express's Request is declared in its global namespace, so augmenting it can only be done there
  namespace Express {
    interface Request {
      requestId: string;
      log: Logger;
    }
  }
}

function generateRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface RequestLoggerOptions {
  /** Skip logging for certain paths (e.g., health checks) */
  skip?: (req: Request) => boolean;
  /** Additional context to include in all logs */
  context?: Record<string, unknown>;
  /**
   * Where to write. Defaults to the logger's own default (stdout).
   *
   * The MCP server MUST pass "stderr": stdout is reserved for the MCP protocol
   * there, and request logs written to it are both invisible in the service's
   * error log and mixed into a stream a client is parsing.
   */
  transport?: "stdout" | "stderr" | "silent";
}

/**
 * Replace identifier-looking path segments with `:id`.
 *
 * Without this every session id is its own route: the live logs show three ids
 * producing three "endpoints" for the same handler, which makes a top-routes
 * panel meaningless and would blow up any `summarize by path` aggregation.
 *
 * The rules are deliberately narrow. Over-templating is its own failure — if a
 * real route segment collapses to `:id` the panel silently groups unrelated
 * endpoints and the numbers stop meaning anything. So a segment is only
 * templated when it is shaped like an identifier and NOT like a word:
 *
 *   - all digits                      (`/identities/42`)
 *   - a UUID
 *   - nanoid-shaped: 16+ chars from the nanoid alphabet, AND containing a digit,
 *     `-` or `_`, or mixed case. `messages` and `available` are long lowercase
 *     words and stay; `F_1aL9OLQsKGNCZNxxyC9` goes.
 */
export function templatePath(path: string): string {
  if (!path || path === "/") return path;

  return path
    .split("/")
    .map((segment) => (isIdentifier(segment) ? ":id" : segment))
    .join("/");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NANOID_ALPHABET = /^[A-Za-z0-9_-]+$/;

function isIdentifier(segment: string): boolean {
  if (segment.length === 0) return false;
  if (/^\d+$/.test(segment)) return true;
  if (UUID.test(segment)) return true;

  // Long enough to be an id rather than a word, and drawn only from the nanoid
  // alphabet.
  if (segment.length < 16 || !NANOID_ALPHABET.test(segment)) return false;

  // A long all-lowercase-letters segment is a word ("subscriptions"), not an id.
  // Requiring a digit, separator or mixed case is what keeps real routes intact.
  const hasDigit = /\d/.test(segment);
  const hasSeparator = /[-_]/.test(segment);
  const mixedCase = /[a-z]/.test(segment) && /[A-Z]/.test(segment);
  return hasDigit || hasSeparator || mixedCase;
}

/**
 * Express middleware for request logging
 *
 * @param service - The service name
 * @param options - Optional configuration
 *
 * @example
 * ```typescript
 * import express from "express";
 * import { createRequestLogger } from "./index.js";
 *
 * const app = express();
 * app.use(createRequestLogger("web", {
 *   skip: (req) => req.path === "/health",
 * }));
 *
 * app.get("/api/users", (req, res) => {
 *   req.log.info("Fetching users", { userId: req.params.id });
 *   // ...
 * });
 * ```
 */
export function createRequestLogger(
  service: string,
  options: RequestLoggerOptions = {}
): RequestHandler {
  const { skip, context = {}, transport } = options;
  const baseLogger = getLoggerFactory()(service, transport ? { transport } : undefined);

  return (req: Request, res: Response, next: NextFunction): void => {
    if (skip?.(req)) {
      next();
      return;
    }

    const requestId = generateRequestId();
    const startTime = Date.now();

    // Capture the original path before routing can rewrite req.path.
    // Rationale: docs/decisions/0022-sdk-auth-and-logging-invariants.md.
    const rawPath = req.originalUrl ? req.originalUrl.split("?")[0] : req.path;
    const routePath = templatePath(rawPath);

    // Template paths keep log-field cardinality bounded across distinct URLs.

    req.requestId = requestId;
    req.log = baseLogger.child({
      requestId,
      ...context,
    });

    req.log.info("request.start", {
      method: req.method,
      path: routePath,
      // Query string is NOT logged as its own field. The sink caps a dataset at
      // 257 columns and this one is at the limit: an object here becomes a
      // column per parameter ("adding 'query.sessionId' to dataset fields would
      // exceed the column limit"), and even a single serialized `query` column
      // was rejected. A field that cannot be ingested is worse than an absent
      // one — the logs still look complete while that service's lines are
      // silently dropped, which is exactly what happened to the MCP server.
      //
      // The path and requestId are enough to find a call in the local log.
      ip: req.ip || req.socket.remoteAddress,
      userAgent: req.get("user-agent"),
    });

    res.on("finish", () => {
      const duration = Date.now() - startTime;
      const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";

      req.log[level]("request.end", {
        method: req.method,
        path: routePath,
        statusCode: res.statusCode,
        duration,
      });
    });

    next();
  };
}

/**
 * Error logging middleware
 * Place after your routes to log errors
 *
 * @example
 * ```typescript
 * app.use(routes);
 * app.use(createErrorLogger("web"));
 * ```
 */
export function createErrorLogger(
  service: string
): ErrorRequestHandler {
  const log = getLoggerFactory()(service);

  return (err: Error, req: Request, res: Response, next: NextFunction): void => {
    const logger = req.log || log;

    logger.error("request.error", {
      error: err.message,
      stack: err.stack,
      method: req.method,
      path: req.path,
      requestId: req.requestId,
    });

    next(err);
  };
}
