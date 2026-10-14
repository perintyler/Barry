import type { EventRecord } from "./store.js";
import { EventSchema } from "@barry-rocks/sdk/events";

export function serializeEvent(record: EventRecord) {
  return EventSchema.parse({
    id: record.id,
    type: record.type,
    sessionId: record.session_id,
    source: record.source,
    title: record.title,
    body: record.body,
    severity: record.severity,
    data: record.data,
    metadata: record.metadata,
    deliveredVia: record.delivered_via,
    readAt: record.read_at?.toISOString() ?? null,
    createdAt: record.created_at.toISOString(),
  });
}

export function encodeEventCursor(event: EventRecord): string {
  // `seq` rides along because `created_at` has millisecond resolution: a burst
  // lands several events in one, and the id tiebreak is a random nanoid. A
  // cursor without it can repeat or drop a row at a page boundary.
  return Buffer.from(
    JSON.stringify({
      createdAt: event.created_at.toISOString(),
      id: event.id,
      seq: event.seq,
    }),
    "utf8",
  ).toString("base64url");
}

export function decodeEventCursor(
  value: unknown,
): { createdAt: string; id: string; seq?: number } | null {
  if (typeof value !== "string" || value.length > 512) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") return null;
    // A cursor minted before `seq` existed still decodes; the store falls back
    // to looking the sequence up by id.
    return {
      createdAt: parsed.createdAt,
      id: parsed.id,
      ...(typeof parsed.seq === "number" ? { seq: parsed.seq } : {}),
    };
  } catch {
    return null;
  }
}
