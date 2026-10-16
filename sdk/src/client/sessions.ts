import { BarryApiError } from "./errors.js";
import { changesRoutes } from "../routes/changes.js";
import { sessionsRoutes } from "../routes/sessions.js";
import { z } from "zod";
import { SessionListResponseSchema, SearchResponseSchema, CreateSessionRequestSchema, UpdateSessionRequestSchema, SendMessageResponseSchema, MessageListResponseSchema, type CreateSessionResponse, type Session } from "../sessions/types.js";

import type { ApiTransport, RequestOptions } from "./http.js";
import { cursorPages, pageItems } from "./pagination.js";

export type CreateSessionInput = z.input<typeof CreateSessionRequestSchema>;
export type UpdateSessionInput = z.input<typeof UpdateSessionRequestSchema>;
export type { CreateSessionResponse };

export interface SessionListOptions {
  identityId?: number;
  active?: boolean;
  order?: "created_at" | "activity";
  includeArchived?: boolean;
  /** 1–100. */
  limit?: number;
  /** `nextCursor` from a previous page. */
  cursor?: string;
  query?: string;
  hasMessages?: boolean;
}

/** Session records and creation; stream execution with AgUiConnection. */
export class Sessions {
  private readonly http: ApiTransport;

  // A field, not a parameter property: strip-only type stripping cannot
  // transform those, and bundled bag code must load under plain Node.
  constructor(http: ApiTransport) {
    this.http = http;
  }

  async create(input: CreateSessionInput, request: RequestOptions = {}): Promise<CreateSessionResponse> {
    const inputBody = input;
    const created = await this.http.call(sessionsRoutes.createSession, { body: inputBody }, { ...request });
    return created!;
  }

  async update(id: string, input: UpdateSessionInput, request: RequestOptions = {}): Promise<Session> {
    const inputBody = input;
    const updated = await this.http.call(sessionsRoutes.updateSession, { params: { sessionId: id }, body: inputBody }, { ...request });
    return updated!;
  }

  /** The session, or null when no session has this id. */
  get(id: string, request: RequestOptions = {}): Promise<Session | null> {
    return this.http.call(sessionsRoutes.getSession, { params: { sessionId: id } }, { ...request, notFound: "null" });
  }

  /** Fetch the next page only when the consumer advances the iterator. */
  pages(options: SessionListOptions = {}, request: RequestOptions = {}): AsyncGenerator<z.infer<typeof SessionListResponseSchema>> {
    const filters = { ...options };
    const controls = { ...request };
    return cursorPages(cursor => this.list({ ...filters, cursor }, controls), filters.cursor, controls.signal);
  }

  /** Iterate individual records, with no requests after an early loop exit. */
  iterate(options: SessionListOptions = {}, request: RequestOptions = {}): AsyncGenerator<Session> {
    return pageItems(this.pages(options, request), page => page.sessions, request.signal);
  }

  async list(options: SessionListOptions = {}, request: RequestOptions = {}): Promise<z.infer<typeof SessionListResponseSchema>> {
    const page = await this.http.call(sessionsRoutes.listSessions, { query: { ...options } }, { ...request });
    return { ...page!, sessions: page!.sessions.map(session => {
      if (!("name" in session)) throw new BarryApiError("Session listing omitted its record fields", { status: 200, code: "malformed_response" });
      return session;
    }) };
  }

  /** Send a session a message: its next turn, or a queued one while it runs. */
  async send(id: string, content: string, options: { clientMessageId?: string } = {}, request: RequestOptions = {}): Promise<z.infer<typeof SendMessageResponseSchema>> {
    const body = { content, ...(options.clientMessageId ? { clientMessageId: options.clientMessageId } : {}) };
    const sent = await this.http.call(sessionsRoutes.sendMessage, { params: { sessionId: id }, body }, request);
    if (sent?.ok===false && !("sessionId" in sent)) {
      throw new BarryApiError(typeof sent.error==="string" ? sent.error : "Session admission unavailable",{status:503,code:typeof sent.code==="string" ? sent.code : "http_503",detail:sent});
    }
    return SendMessageResponseSchema.parse(Object.assign({ok:true},sent));
  }

  /** A page of messages, oldest first; after catches up, before reads older history. */
  async messages(id: string, options: { after?: number; before?: number; limit?: number; summary?: boolean } = {}, request: RequestOptions = {}): Promise<z.infer<typeof MessageListResponseSchema>> {
    const page = await this.http.call(sessionsRoutes.listMessages, { params: { sessionId: id }, query: { ...options } }, { ...request });
    return page!;
  }

  /** What the live surfaces for these sessions can promise. */
  async guarantees(sessionIds: string[], request: RequestOptions = {}) {
    const result = await this.http.call(sessionsRoutes.listDeliveryGuarantees, { body: { sessionIds } }, request);
    return result!.guarantees;
  }

  async changes(id: string, request: RequestOptions = {}) {
    const result = await this.http.call(changesRoutes.listSessionChanges, { params: { sessionId: id } }, request);
    return result!.changes;
  }

  /** Stop a session's current run. */
  async stop(id: string, request: RequestOptions = {}): Promise<void> {
    await this.http.call(sessionsRoutes.stopSession, { params: { sessionId: id } }, request);
  }

  /** Archive a session. */
  async archive(id: string, request: RequestOptions = {}): Promise<void> {
    await this.http.call(sessionsRoutes.archiveSessionLegacy, { params: { sessionId: id } }, request);
  }

  /** Full-text search over session messages; `query` needs at least two characters. */
  async search(
    query: string,
    options: { limit?: number; sessionId?: string; role?: "user" | "assistant" } = {},
    request: RequestOptions = {},
  ): Promise<z.infer<typeof SearchResponseSchema>["results"]> {
    const found = await this.http.call(sessionsRoutes.searchSessions, { query: { q: query, ...options } }, { ...request });
    return found!.results;
  }
}
