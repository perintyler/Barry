import { resolveCredential, validateCredentials, type ClientCredentials } from "../client/credentials.js";
import { BarryApiError } from "../client/errors.js";
import { errorFrom, validTimeout, type RequestOptions } from "../client/http.js";
import type { Message } from "@ag-ui/core";
import { parseAgUiEvent, type AgUiEvent, type RunAgentInput } from "./ag-ui.js";
import type { TurnSnapshot, ApprovalContinuation } from "../sessions/index.js";
import { PublicSessionSnapshotSchema, PublicTurnSchema } from "./wire.js";

export interface PublicSessionSnapshot {
  threadId: string;
  turn: TurnSnapshot | null;
  cursor: number;
  messages: Message[];
  protocolVersion: string;
  appExtensionVersion: number;
  agUiPackageVersion: string;
  capabilities: {
    approvalContinuation: ApprovalContinuation;
    frontendTools: boolean;
    approveWithEdits: boolean;
    attachments: boolean;
    replay: boolean;
  };
}
export interface AgUiConnectionOptions extends ClientCredentials {
  /** Sessions root, such as http://localhost:4885/api/v2/sessions. */
  baseUrl: string;
  fetch?: typeof fetch;
  maxFrameBytes?: number;
  /** HTTP deadline; streaming deadlines end after the response headers arrive. */
  timeoutMs?: number;
}
export interface AgUiDelivery { cursor: string; event: AgUiEvent }
export interface AgUiSubscriptionOptions extends RequestOptions {
  after?: string | number;
  /** Opt-in GET reconnects; writes are never retried. At most ten reconnects. */
  reconnect?: { maxAttempts: number; delayMs?: number };
}

function replayCursor(value: string | number): [number, number] {
  const text = String(value);
  const parts = text.split(":").map(Number);
  if (!/^\d+(?::\d+)?$/.test(text) || !parts.every(Number.isSafeInteger)) throw new Error("Invalid replay cursor");
  return [parts[0], parts[1] ?? Number.MAX_SAFE_INTEGER];
}

interface RequestScope {
  controller: AbortController;
  response?: Response;
  stopDeadline(): void;
  dispose(): void;
}

/** A connection starts no work until an operation is explicitly invoked. */
export class AgUiConnection {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly controllers = new Set<AbortController>();
  private closed = false;

  private readonly options: AgUiConnectionOptions;

  constructor(options: AgUiConnectionOptions) {
    let url: URL;
    try { url = new URL(options.baseUrl); }
    catch { throw new BarryApiError("Invalid AG-UI baseUrl", { status: null, code: "invalid_request" }); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new BarryApiError("AG-UI baseUrl must be an HTTP(S) URL without credentials, query or fragment", { status: null, code: "invalid_request" });
    }
    validateCredentials(options);
    validTimeout(options.timeoutMs ?? 10_000);
    if (options.maxFrameBytes !== undefined && (!Number.isSafeInteger(options.maxFrameBytes) || options.maxFrameBytes <= 0)) {
      throw new BarryApiError("maxFrameBytes must be a positive safe integer", { status: null, code: "invalid_request" });
    }
    this.options = { ...options };
    this.baseUrl = url.href.replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  private scope(options: RequestOptions): RequestScope {
    if (this.closed) throw new BarryApiError("AG-UI connection is closed", { status: null, code: "connection_closed" });
    const timeoutMs = validTimeout(options.timeoutMs ?? this.options.timeoutMs ?? 10_000);
    const controller = new AbortController();
    const abort = () => controller.abort("cancelled");
    if (options.signal?.aborted) abort(); else options.signal?.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => controller.abort("timeout"), timeoutMs);
    const stopDeadline = () => { clearTimeout(timer); timer = undefined; };
    this.controllers.add(controller);
    return { controller, stopDeadline, dispose: () => {
      stopDeadline();
      options.signal?.removeEventListener("abort", abort);
      controller.abort("cancelled");
      this.controllers.delete(controller);
    } };
  }

  private failure(error: unknown, scope: RequestScope, response?: Response): BarryApiError {
    response ??= scope.response;
    const code = scope.controller.signal.aborted ? String(scope.controller.signal.reason) : undefined;
    if (code) return new BarryApiError(code === "timeout" ? "Barry request timed out" : code === "connection_closed" ? "AG-UI connection is closed" : "Barry request was cancelled", {
      status: response?.status ?? null, code, requestId: response?.headers.get("x-request-id") ?? undefined,
    });
    if (error instanceof BarryApiError) return error;
    return new BarryApiError("Barry's AG-UI service is unreachable", { status: response?.status ?? null, code: "unreachable", requestId: response?.headers.get("x-request-id") ?? undefined });
  }

  private async request(sessionId: string, suffix: string, init: RequestInit, scope: RequestScope): Promise<Response> {
    if (scope.controller.signal.aborted) throw this.failure(undefined, scope);
    const url = `${this.baseUrl}/${encodeURIComponent(sessionId)}${suffix}`;
    const headers = new Headers(init.headers);
    headers.set("Content-Type", "application/json");
    const secret = await resolveCredential(this.options, scope.controller.signal);
    scope.controller.signal.throwIfAborted();
    if (secret) headers.set("Authorization", `Bearer ${secret}`);
    const response = await this.fetchFn(url, { ...init, headers, signal: scope.controller.signal });
    scope.response = response;
    if (!response.ok) {
      const text = await response.text();
      let body: unknown;
      try { body = JSON.parse(text); } catch { body = undefined; }
      throw errorFrom(init.method ?? "GET", new URL(url).pathname, response.status, body, response.headers.get("x-request-id") ?? undefined);
    }
    return response;
  }

  private async json<T>(sessionId: string, suffix: string, init: RequestInit, parse: (value: unknown) => T, options: RequestOptions): Promise<T> {
    const scope = this.scope(options);
    let response: Response | undefined;
    try {
      response = await this.request(sessionId, suffix, init, scope);
      const text = await response.text();
      try { return parse(JSON.parse(text)); }
      catch { throw new BarryApiError("Barry returned an invalid AG-UI response", { status: response.status, code: "malformed_response", requestId: response.headers.get("x-request-id") ?? undefined }); }
    } catch (error) { throw this.failure(error, scope, response); }
    finally { scope.dispose(); }
  }

  snapshot(sessionId: string, options: RequestOptions = {}): Promise<PublicSessionSnapshot> {
    return this.json(sessionId, "", {}, value => PublicSessionSnapshotSchema.parse(value), options);
  }

  run(input: RunAgentInput, options: RequestOptions = {}): AsyncIterable<AgUiDelivery> {
    return this.events(input.threadId, "/ag-ui", { method: "POST", body: JSON.stringify(input) }, { ...options });
  }

  async queue(input: RunAgentInput, options: RequestOptions = {}): Promise<{ id: string; state: string }> {
    const queuedInput: RunAgentInput = {
      ...input,
      forwardedProps: {
        ...(input.forwardedProps && typeof input.forwardedProps === "object" ? input.forwardedProps : {}),
        barry: {
          ...((input.forwardedProps as { barry?: Record<string, unknown> } | undefined)?.barry ?? {}),
          ifActive: "queue",
        },
      },
    };
    return this.json(input.threadId, "/ag-ui", {
      method: "POST",
      headers: { Accept: "application/json" },
      body: JSON.stringify(queuedInput),
    }, value => {
      const queued = value as { id?: unknown; state?: unknown } | null;
      if (!queued || typeof queued.id !== "string" || typeof queued.state !== "string") throw new Error("Invalid queued turn");
      return { id: queued.id, state: queued.state };
    }, options);
  }

  subscribe(sessionId: string, options: AgUiSubscriptionOptions = {}): AsyncIterable<AgUiDelivery> {
    const controls = { ...options, reconnect: options.reconnect ? { ...options.reconnect } : undefined };
    try { if (controls.after !== undefined) replayCursor(controls.after); }
    catch { throw new BarryApiError("Invalid replay cursor", { status: null, code: "invalid_request" }); }
    if (controls.reconnect && (!Number.isInteger(controls.reconnect.maxAttempts) || controls.reconnect.maxAttempts < 0 || controls.reconnect.maxAttempts > 10
      || !Number.isInteger(controls.reconnect.delayMs ?? 250) || (controls.reconnect.delayMs ?? 250) < 0 || (controls.reconnect.delayMs ?? 250) > 30_000)) {
      throw new BarryApiError("Reconnect requires 0–10 attempts and a delay of 0–30000ms", { status: null, code: "invalid_request" });
    }
    return this.subscription(sessionId, controls);
  }

  private async *subscription(sessionId: string, options: AgUiSubscriptionOptions): AsyncGenerator<AgUiDelivery> {
    let after = options.after;
    let reconnects = 0;
    while (true) {
      let failure: BarryApiError | undefined;
      try {
        for await (const delivery of this.events(sessionId, `/events${after === undefined ? "" : `?after=${encodeURIComponent(after)}`}`, {}, options)) {
          let cursor: [number, number];
          try { cursor = replayCursor(delivery.cursor); }
          catch { throw new BarryApiError("AG-UI event has no valid replay cursor", { status: 200, code: "malformed_response" }); }
          if (after !== undefined) {
            const previous = replayCursor(after);
            if (cursor[0] < previous[0] || (cursor[0] === previous[0] && cursor[1] <= previous[1])) continue;
          }
          // Commit the read position before yielding so reconnect never repeats a delivered event.
          after = delivery.cursor;
          yield delivery;
        }
      } catch (error) {
        if (!(error instanceof BarryApiError) || !["unreachable", "timeout", "http_502", "http_503", "http_504"].includes(error.code)) throw error;
        failure = error;
      }
      if (!options.reconnect || reconnects >= options.reconnect.maxAttempts) {
        if (failure) throw failure;
        return;
      }
      await this.reconnectDelay(Math.min((options.reconnect.delayMs ?? 250) * 2 ** reconnects, 30_000), options);
      reconnects++;
    }
  }

  private async reconnectDelay(delayMs: number, options: RequestOptions): Promise<void> {
    const scope = this.scope(options);
    scope.stopDeadline();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        abort = () => reject(this.failure(undefined, scope));
        if (scope.controller.signal.aborted) { abort(); return; }
        scope.controller.signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(resolve, delayMs);
      });
    } finally {
      clearTimeout(timer);
      if (abort) scope.controller.signal.removeEventListener("abort", abort);
      scope.dispose();
    }
  }

  cancel(sessionId: string, turnId: string, options: RequestOptions = {}): Promise<TurnSnapshot> {
    return this.json(sessionId, `/turns/${encodeURIComponent(turnId)}/cancel`, { method: "POST", body: "{}" }, value => PublicTurnSchema.parse(value), options);
  }

  private async *events(sessionId: string, suffix: string, init: RequestInit, options: RequestOptions): AsyncGenerator<AgUiDelivery> {
    const scope = this.scope(options);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let response: Response | undefined;
    const cancelReader = () => { void reader?.cancel().catch(() => {}); };
    scope.controller.signal.addEventListener("abort", cancelReader, { once: true });
    try {
      response = await this.request(sessionId, suffix, { ...init, headers: { Accept: "text/event-stream" } }, scope);
      scope.stopDeadline();
      if (scope.controller.signal.aborted) { await response.body?.cancel(); throw this.failure(undefined, scope, response); }
      if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) throw new BarryApiError("Expected an AG-UI event stream", { status: response.status, code: "malformed_response", requestId: response.headers.get("x-request-id") ?? undefined });
      reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const encoder = new TextEncoder(); let buffer = ""; let data: string[] = []; let id = ""; let frameSize = 0;
      const maximum = this.options.maxFrameBytes ?? 2 * 1024 * 1024;
      while (true) {
        const chunk = await reader.read();
        if (scope.controller.signal.aborted) throw this.failure(undefined, scope, response);
        try { buffer += decoder.decode(chunk.value, { stream: !chunk.done }); }
        catch { throw new BarryApiError("Invalid UTF-8 in AG-UI event stream", { status: response.status, code: "malformed_response", requestId: response.headers.get("x-request-id") ?? undefined }); }
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const rawLine = buffer.slice(0, newline);
          const line = rawLine.replace(/\r$/, ""); buffer = buffer.slice(newline + 1);
          frameSize += encoder.encode(rawLine).byteLength + 1;
          if (frameSize > maximum) throw new BarryApiError("AG-UI event exceeds the connection frame limit", { status: response.status, code: "malformed_response", requestId: response.headers.get("x-request-id") ?? undefined });
          if (line === "") {
            if (data.length) {
              let event: AgUiEvent;
              try { replayCursor(id); event = parseAgUiEvent(JSON.parse(data.join("\n"))); }
              catch { throw new BarryApiError("Invalid AG-UI event", { status: response.status, code: "malformed_response", requestId: response.headers.get("x-request-id") ?? undefined }); }
              yield { cursor: id, event };
              if (scope.controller.signal.aborted) throw this.failure(undefined, scope, response);
            }
            data = []; frameSize = 0;
          } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          else if (line.startsWith("id:")) id = line.slice(3).replace(/^ /, "");
        }
        if (encoder.encode(buffer).byteLength + frameSize > maximum) throw new BarryApiError("AG-UI event exceeds the connection frame limit", { status: response.status, code: "malformed_response", requestId: response.headers.get("x-request-id") ?? undefined });
        if (chunk.done) {
          if (buffer || data.length) throw new BarryApiError("AG-UI stream ended with an incomplete frame", { status: response.status, code: "malformed_response", requestId: response.headers.get("x-request-id") ?? undefined });
          break;
        }
      }
    } catch (error) { throw this.failure(error, scope, response); } finally {
      scope.controller.signal.removeEventListener("abort", cancelReader);
      scope.dispose();
      await reader?.cancel().catch(() => {}); reader?.releaseLock();
      if (!reader) await response?.body?.cancel().catch(() => {});
    }
  }

  close(): void {
    this.closed = true;
    for (const controller of this.controllers) controller.abort("connection_closed");
    this.controllers.clear();
  }
}
