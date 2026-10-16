/** Convert Claude OpenTelemetry pushes into Barry capture events.
 * Rationale: docs/decisions/0033-tracked-capture-and-transport-rationale.md.
 */

import type { SessionEvent } from "@barry-rocks/sdk/sessions";

/** One OTLP log record, in the http/json encoding. */
export interface OtelLogRecord {
  body?: { stringValue?: string } | string;
  attributes?: Array<{ key: string; value?: Record<string, unknown> }>;
  timeUnixNano?: string;
}

/** One OTLP span, in the http/json encoding. */
export interface OtelSpan {
  name?: string;
  attributes?: Array<{ key: string; value?: Record<string, unknown> }>;
  events?: Array<{ name?: string; timeUnixNano?: string; attributes?: Array<{ key: string; value?: Record<string, unknown> }> }>;
}

/** An OTLP/HTTP JSON traces payload, as far as this module reads it. */
export interface OtelTracesPayload {
  resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: OtelSpan[] }> }>;
}

/** An OTLP/HTTP JSON payload, as far as this module reads it. */
export interface OtelLogsPayload {
  resourceLogs?: Array<{
    resource?: { attributes?: Array<{ key: string; value?: Record<string, unknown> }> };
    scopeLogs?: Array<{ logRecords?: OtelLogRecord[] }>;
  }>;
}

/** Flatten an OTel attribute value, whose type lives in the key name. */
function attrValue(value: Record<string, unknown> | undefined): string | number | undefined {
  if (!value) return undefined;
  if (typeof value.stringValue === "string") return value.stringValue;
  if (typeof value.intValue === "string") return Number(value.intValue);
  if (typeof value.intValue === "number") return value.intValue;
  if (typeof value.doubleValue === "number") return value.doubleValue;
  if (typeof value.boolValue === "boolean") return String(value.boolValue);
  return undefined;
}

export function readAttributes(
  attributes: Array<{ key: string; value?: Record<string, unknown> }> | undefined,
): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  for (const { key, value } of attributes ?? []) {
    const read = attrValue(value);
    if (read !== undefined) result[key] = read;
  }
  return result;
}

/** One captured record: which claude session it belongs to, and what it says. */
export interface CapturedTelemetry {
  /** The vendor's session id — `session.id` on every claude OTel event. */
  harnessSessionId: string;
  event: SessionEvent;
  /**
   * Stable identity for this record, so a receiver that is called twice with
   * the same batch stores it once.
   *
   * Built from the event name, the prompt id and the timestamp: claude gives
   * no record id, and content alone is not unique (an agent may legitimately
   * say the same thing twice).
   */
  dedupeKey: string;
}

/**
 * Read one OTLP payload as Barry events.
 *
 * Records Barry has no vocabulary for are DROPPED rather than forwarded as
 * text — `tool_decision` and `api_request` carry useful operational detail but
 * no conversational content, and putting them in a transcript would be noise
 * that reads like something the agent said.
 */
export function telemetryToEvents(payload: OtelLogsPayload): CapturedTelemetry[] {
  const captured: CapturedTelemetry[] = [];

  for (const resourceLog of payload.resourceLogs ?? []) {
    for (const scopeLog of resourceLog.scopeLogs ?? []) {
      for (const record of scopeLog.logRecords ?? []) {
        const attributes = readAttributes(record.attributes);
        const harnessSessionId = attributes["session.id"];
        // Without a session id there is nothing to attach the row to. Dropping
        // is right: the alternative is inventing an owner for it.
        if (typeof harnessSessionId !== "string") continue;

        const eventName = eventNameOf(attributes["event.name"] ?? attributes["name"] ?? bodyText(record));
        const event = recordToEvent(eventName, attributes, record);
        if (!event) continue;

        captured.push({
          harnessSessionId,
          event,
          dedupeKey: [
            "otel",
            eventName,
            attributes["prompt.id"] ?? "",
            record.timeUnixNano ?? "",
          ].join(":"),
        });
      }
    }
  }

  return captured;
}

/**
 * Tool OUTPUT, which claude sends only on its traces: a `tool.output` event on
 * the tool's span, with the call id on the span (2.1.282). The logs carry the
 * call; this carries what it returned.
 */
export function telemetrySpansToEvents(payload: OtelTracesPayload): CapturedTelemetry[] {
  const captured: CapturedTelemetry[] = [];
  for (const resourceSpan of payload.resourceSpans ?? []) {
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      for (const span of scopeSpan.spans ?? []) {
        if (span.name !== "claude_code.tool") continue;
        const spanAttributes = readAttributes(span.attributes);
        const harnessSessionId = spanAttributes["session.id"];
        if (typeof harnessSessionId !== "string") continue;
        const toolUseId = spanAttributes["tool_use_id"];
        for (const event of span.events ?? []) {
          if (event.name !== "tool.output") continue;
          const output = readAttributes(event.attributes)["output"];
          if (output === undefined) continue;
          captured.push({
            harnessSessionId,
            event: { type: "tool_result", result: output, ...(toolUseId !== undefined ? { id: String(toolUseId) } : {}) },
            dedupeKey: ["otel", "tool.output", toolUseId ?? "", event.timeUnixNano ?? ""].join(":"),
          });
        }
      }
    }
  }
  return captured;
}

/**
 * An event's name without the `claude_code.` prefix: 2.1.282 names them bare
 * in `event.name` (the prefixed form rides in the body), where the builds the
 * mapping was first written against prefixed them. Read either way.
 */
function eventNameOf(value: string | number | undefined): string {
  const name = String(value ?? "");
  return name.startsWith("claude_code.") ? name.slice("claude_code.".length) : name;
}

/** A value claude sends as JSON text, as the object it describes. */
function parsedJson(value: string | number | undefined): unknown {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function bodyText(record: OtelLogRecord): string | undefined {
  if (typeof record.body === "string") return record.body;
  if (record.body && typeof record.body.stringValue === "string") return record.body.stringValue;
  return undefined;
}

function recordToEvent(
  eventName: string,
  attributes: Record<string, string | number>,
  record: OtelLogRecord,
): SessionEvent | null {
  switch (eventName) {
    case "user_prompt": {
      const text = attributes["prompt"] ?? bodyText(record);
      return typeof text === "string" && text ? { type: "text", text, role: "user" } : null;
    }

    case "assistant_response": {
      const text = attributes["response"] ?? bodyText(record);
      return typeof text === "string" && text
        ? { type: "text", text, role: "assistant" }
        : null;
    }

    case "tool_result": {
      const name = attributes["tool_name"] ?? attributes["name"];
      if (typeof name !== "string") return null;
      // `tool_input` is the call; the OUTPUT arrives on the tool span's
      // `tool.output` event, handled below, which is why these are two rows.
      return {
        type: "tool_use",
        tool: name,
        input: parsedJson(attributes["tool_input"]),
        id: String(attributes["tool_use_id"] ?? `${name}-${record.timeUnixNano ?? ""}`),
      };
    }

    case "tool.output": {
      const output = attributes["output"] ?? bodyText(record);
      if (output === undefined) return null;
      return {
        type: "tool_result",
        result: output,
        ...(attributes["tool_use_id"] ? { id: String(attributes["tool_use_id"]) } : {}),
      };
    }

    case "api_request": {
      const input = attributes["input_tokens"];
      const output = attributes["output_tokens"];
      if (typeof input !== "number" && typeof output !== "number") return null;
      const inputTokens = typeof input === "number" ? input : 0;
      const outputTokens = typeof output === "number" ? output : 0;
      return {
        type: "done",
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          ...(typeof attributes["cache_read_tokens"] === "number"
            ? { cacheReadTokens: attributes["cache_read_tokens"] }
            : {}),
        },
      };
    }

    default:
      // `tool_decision` and anything else: operational, not conversational.
      return null;
  }
}
