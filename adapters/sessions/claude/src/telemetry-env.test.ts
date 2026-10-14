import { describe, expect, it } from "vitest";
import type { SessionConfig } from "@barry-rocks/sdk/sessions";
import adapter from "./adapter.js";
import { claudeTelemetryEnv } from "./telemetry-env.js";

describe("the telemetry environment", () => {
  const env = claudeTelemetryEnv("http://127.0.0.1:3865");

  it("enables telemetry and points it at Barry, in the format Barry's receiver parses", () => {
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://127.0.0.1:3865");
    expect(env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe("http/json");
  });

  it("asks for prompts, replies and tool details, not just event shapes", () => {
    expect(env.OTEL_LOG_USER_PROMPTS).toBe("1");
    expect(env.OTEL_LOG_ASSISTANT_RESPONSES).toBe("1");
    expect(env.OTEL_LOG_TOOL_DETAILS).toBe("1");
  });

  it("asks for tool output, which only arrives on traces", () => {
    expect(env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA).toBe("1");
    expect(env.OTEL_TRACES_EXPORTER).toBe("otlp");
    expect(env.OTEL_LOG_TOOL_CONTENT).toBe("1");
  });
});

describe("an instrumented launch, with and without a receiver", () => {
  const base: SessionConfig = {
    sessionId: "s",
    cwd: "/repo",
    env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-identity" },
    mcpServers: {},
    options: { mcpConfigPath: "/tmp/mcp.json" },
  };
  const plan = (config: SessionConfig) => adapter.modes.instrumented!.plan(config);

  it("carries the telemetry env when Barry has a receiver", async () => {
    const launched = await plan({ ...base, telemetryEndpoint: "http://127.0.0.1:3865" });
    expect(launched.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
    expect(launched.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://127.0.0.1:3865");
  });

  it("sends the receiver's auth unencoded, because Barry refuses a batch without it", async () => {
    const launched = await plan({ ...base, telemetryEndpoint: "http://127.0.0.1:3865", telemetryHeaders: { Authorization: "Bearer s3cret" } });
    expect(launched.env.OTEL_EXPORTER_OTLP_HEADERS).toBe("Authorization=Bearer s3cret");
  });

  it("launches without telemetry rather than failing when there is no receiver", async () => {
    const launched = await plan(base);
    expect(launched.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined();
    expect(launched.command).toBe("claude");
  });

  it("stops the binary updating itself either way, so it stays the build the guarantees were verified on", async () => {
    expect((await plan(base)).env.DISABLE_AUTOUPDATER).toBe("1");
  });
});
