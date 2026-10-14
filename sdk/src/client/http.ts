import type { Route, RouteResponse } from "../routes/route.js";
import { BarryApiError } from "./errors.js";
import { resolveCredential, validateCredentials, type ClientCredentials } from "./credentials.js";

export interface ServiceClientOptions extends ClientCredentials {
  baseUrl: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface BarryClientOptions extends ClientCredentials {
  /** Identity administration and device pairing share this separate service. Credentials are explicit. */
  identities?: ServiceClientOptions;
  /** Service control uses the MCP server and its own credentials. */
  services?: ServiceClientOptions;
  /**
   * The API base URL, with or without the `/api/v1` suffix.
   */
  baseUrl?: string;
  /** Per-request deadline, in milliseconds. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** For tests and non-Node runtimes. */
  fetch?: typeof fetch;
}

/** Controls for one request; pass separately from resource filters or inputs. */
export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function validTimeout(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new BarryApiError("timeoutMs must be an integer between 1 and 2147483647", { status: null, code: "invalid_request" });
  }
  return value;
}

/** Anything with zod's safeParse — keeps the client independent of zod's major. */
export interface ResponseSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { message: string } };
}

const API_PREFIX = "/api/v1";
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Callers may pass the base with or without `/api/v1`, so accept both.
 */
export function apiBaseUrl(explicit?: string): string {
  if (!explicit) throw new TypeError("Barry.connect requires baseUrl; use Barry.connect(await localConnection()) with localConnection from @barry-rocks/sdk/services for local service discovery.");
  const endpoint = new URL(explicit);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new TypeError("Barry baseUrl must be an HTTP(S) URL without credentials, query or fragment.");
  const raw = endpoint.href.replace(/\/+$/, "");
  return raw.endsWith(API_PREFIX) ? raw : `${raw}${API_PREFIX}`;
}

type Query = Record<string, string | number | boolean | undefined>;

/**
 * One HTTP request against the API, answering a validated value or throwing
 * BarryApiError. Nothing is retried: several of these calls create things, and
 * a retry after a response was lost would create them twice.
 */
export class ApiTransport {
  private readonly baseUrl: string;
  private readonly credentials: ClientCredentials;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BarryClientOptions = {}) {
    this.baseUrl = apiBaseUrl(options.baseUrl);
    validateCredentials(options);
    this.credentials = { secret: options.secret, resolveCredential: options.resolveCredential };
    this.timeoutMs = validTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.fetchImpl = options.fetch ?? fetch;
  }

  async call<R extends Route>(
    declaration: R,
    input: { params?: Record<string, string | number>; query?: Query; body?: unknown } = {},
    options: RequestOptions & { notFound?: "null" } = {},
  ): Promise<RouteResponse<R> | null> {
    let body = input.body;
    if (declaration.body) {
      const result = declaration.body.safeParse(body);
      if (!result.success) throw new BarryApiError(`Invalid ${declaration.operationId} input: ${result.error.message}`, { status: null, code: "invalid_request", detail: declaration.sensitive ? undefined : result.error.issues });
      body = result.data;
    }
    const path = declaration.path.replace(/\{([^}]+)\}/g, (_match, key: string) => {
      const value = input.params?.[key];
      if (value === undefined || String(value).length === 0) throw new BarryApiError(`Missing path parameter ${key}`, { status: null, code: "invalid_request" });
      const schema = declaration.params?.shape[key];
      if (schema && !schema.safeParse(value).success) throw new BarryApiError(`Invalid path parameter ${key}`, { status: null, code: "invalid_request" });
      return encodeURIComponent(String(value));
    });
    const schemas: Record<number, ResponseSchema<unknown>> = {};
    for (const [status, schema] of Object.entries(declaration.responses)) {
      schemas[Number(status)] = schema ?? { safeParse: value => value === undefined ? { success: true, data: undefined } : { success: false, error: { message: "Expected no response body" } } };
    }
    return await this.request(declaration.method.toUpperCase() as "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path, schemas[200] ?? Object.values(schemas)[0], {
      ...options, query: input.query, body,
      responseSchemas: schemas, sensitiveResponse: declaration.sensitive,
    }) as RouteResponse<R> | null;
  }

  async request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    schema: ResponseSchema<T>,
    options: RequestOptions & { query?: Query; body?: unknown; notFound?: "null"; sensitiveResponse?: boolean;
      responseSchemas?: Readonly<Record<number, ResponseSchema<T>>> } = {},
  ): Promise<T | null> {
    const url = new URL(path.startsWith("/api/") ? `${new URL(this.baseUrl).origin}${path}` : `${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const timeoutMs = validTimeout(options.timeoutMs ?? this.timeoutMs);
    if (options.signal?.aborted) {
      throw new BarryApiError("Barry request was cancelled", { status: null, code: "cancelled" });
    }
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    let response: Response | undefined;
    let text: string;
    try {
      const secret = await resolveCredential(this.credentials, signal);
      signal.throwIfAborted();
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Accept: "application/json",
          // Sent even on GET: the API's CSRF guard rejects a state-changing
          // request without a JSON content type, and sending it always means no
          // caller has to know which routes that covers.
          "Content-Type": "application/json",
          ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal,
      });
      text = await response.text();
    } catch (error) {
      const timedOut = deadline.aborted && signal.reason === deadline.reason;
      const cancelled = !timedOut && options.signal?.aborted;
      if (!timedOut && !cancelled && error instanceof BarryApiError && error.code === "credential_error") throw error;
      throw new BarryApiError(
        cancelled ? "Barry request was cancelled"
          : timedOut ? `${method} ${url.pathname} got no answer within ${timeoutMs}ms`
          : `Barry's API is unreachable at ${this.baseUrl}`,
        { status: response?.status ?? null, code: cancelled ? "cancelled" : timedOut ? "timeout" : "unreachable",
          requestId: response?.headers.get("x-request-id") ?? undefined },
      );
    }
    const requestId = response.headers.get("x-request-id") ?? undefined;

    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    const responseSchema = options.responseSchemas ? options.responseSchemas[response.status] : schema;
    const parsed = responseSchema?.safeParse(body);
    if (!response.ok && (!options.responseSchemas || !parsed?.success)) {
      if (response.status === 404 && options.notFound === "null") return null;
      if (options.sensitiveResponse) {
        throw new BarryApiError(`${method} ${url.pathname} → ${response.status}`, { status: response.status, code: `http_${response.status}`, requestId });
      }
      throw errorFrom(method, url.pathname, response.status, body, requestId);
    }

    if (!parsed?.success) {
      if (options.sensitiveResponse) {
        throw new BarryApiError(`${method} ${url.pathname} answered with an unexpected shape`, { status: response.status, code: "malformed_response", requestId });
      }
      throw new BarryApiError(`${method} ${url.pathname} answered with an unexpected shape${parsed ? `: ${parsed.error.message}` : ""}`, {
        status: response.status,
        code: "malformed_response",
        detail: body,
        requestId,
      });
    }
    return parsed.data;
  }
}

/** Both error dialects the API speaks: RFC 7807 problems, and the actions routes' `{error, message}`. */
export function errorFrom(method: string, path: string, status: number, body: unknown, requestId?: string): BarryApiError {
  const record = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (typeof record.title === "string") {
    const detail = typeof record.detail === "string" ? `: ${record.detail}` : "";
    return new BarryApiError(`${method} ${path} → ${status} ${record.title}${detail}`, { status, code: `http_${status}`, detail: body, requestId });
  }
  if (typeof record.error === "string") {
    const message = typeof record.message === "string" ? `: ${record.message}` : "";
    return new BarryApiError(`${method} ${path} → ${status} ${record.error}${message}`, { status, code: record.error, detail: body, requestId });
  }
  return new BarryApiError(`${method} ${path} → ${status}`, { status, code: `http_${status}`, detail: body, requestId });
}
