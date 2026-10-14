/**
 * The environment that makes a claude TUI send its prompts, replies and tool
 * calls to Barry's OpenTelemetry receiver.
 *
 * It is all-or-nothing on purpose: with any one variable missing, claude still
 * exports but leaves that content out, and the session looks as if the agent
 * said nothing.
 */
export function claudeTelemetryEnv(receiverUrl: string, headers: Record<string, string> = {}): Record<string, string> {
  // Values go unencoded: claude's exporter does not decode them, so an encoded
  // token would reach the receiver wrong and every batch would be refused.
  const otlpHeaders = Object.entries(headers)
    .map(([name, value]) => `${name}=${value}`)
    .join(",");
  return {
    ...(otlpHeaders ? { OTEL_EXPORTER_OTLP_HEADERS: otlpHeaders } : {}),
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: receiverUrl,
    OTEL_LOG_USER_PROMPTS: "1",
    OTEL_LOG_TOOL_DETAILS: "1",
    OTEL_LOG_ASSISTANT_RESPONSES: "1",
    // Tool output is only exported on traces, and only behind this beta flag.
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_LOG_TOOL_CONTENT: "1",
  };
}
