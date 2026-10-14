import { BarryError, type Caller, type Events as EventsSubject } from "@barry-rocks/sdk";
import { createEvent, listEvents } from "./store.js";
import { serializeEvent, encodeEventCursor, decodeEventCursor } from "./domain.js";

function allowed(caller: Caller): void {
  if (caller.kind === "device") throw new BarryError("forbidden", "A device may not read or record events");
}

export const events: EventsSubject = {
  name: "events",
  async list(query, cursor, caller) {
    allowed(caller);
    const before = cursor === null ? undefined : decodeEventCursor(cursor);
    if (before === null) throw new BarryError("invalid", "The event cursor is malformed");
    const rows = await listEvents({
      sessionId: query.session, type: query.type, unreadOnly: query.unread, since: query.since,
      before, limit: 51,
    });
    const page = rows.slice(0, 50);
    return { items: page.map(serializeEvent), next: rows.length > 50 ? encodeEventCursor(page[page.length - 1]) : null };
  },
  async record(input, caller) {
    allowed(caller);
    return serializeEvent(await createEvent({
      type: input.type, title: input.title, source: "api", session_id: input.session ?? null,
      body: input.body ?? null, severity: input.severity ?? "info", data: input.data ?? {}, metadata: {},
    }));
  },
};
