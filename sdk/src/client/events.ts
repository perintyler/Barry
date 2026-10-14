import { eventsRoutes } from "../routes/events.js";
import { z } from "zod";
import { CreateEventRequestSchema, EventListResponseSchema, type BarryEvent } from "../events/index.js";

import type { ApiTransport, RequestOptions } from "./http.js";
import { cursorPages, pageItems } from "./pagination.js";

export type CreateEventInput = z.input<typeof CreateEventRequestSchema>;

export interface EventListOptions {
  type?: string;
  sessionId?: string;
  severity?: string;
  unread?: boolean;
  /** ISO timestamp. */
  since?: string;
  /** 1–100. */
  limit?: number;
  cursor?: string;
}

export class Events {
  private readonly http: ApiTransport;

  // A field, not a parameter property: strip-only type stripping cannot
  // transform those, and bundled bag code must load under plain Node.
  constructor(http: ApiTransport) {
    this.http = http;
  }

  /**
   * Record an event. The API owns hook dispatch, so creating it here — not by
   * writing events.db — is what lets other bags' `hooks.barry` react to it.
   * Validated before sending, so a malformed event never costs a round trip.
   */
  async create(input: CreateEventInput, request: RequestOptions = {}): Promise<BarryEvent> {
    const inputBody = input;
    const created = await this.http.call(eventsRoutes.createEvent, { body: inputBody }, { ...request });
    return created!.event;
  }

  /** Fetch the next page only when the consumer advances the iterator. */
  pages(options: EventListOptions = {}, request: RequestOptions = {}): AsyncGenerator<z.infer<typeof EventListResponseSchema>> {
    const filters = { ...options };
    const controls = { ...request };
    return cursorPages(cursor => this.list({ ...filters, cursor }, controls), filters.cursor, controls.signal);
  }

  /** Iterate individual records, with no requests after an early loop exit. */
  iterate(options: EventListOptions = {}, request: RequestOptions = {}): AsyncGenerator<BarryEvent> {
    return pageItems(this.pages(options, request), page => page.events, request.signal);
  }

  async list(options: EventListOptions = {}, request: RequestOptions = {}): Promise<z.infer<typeof EventListResponseSchema>> {
    const page = await this.http.call(eventsRoutes.listEvents, { query: { ...options } }, { ...request });
    return page!;
  }
}
