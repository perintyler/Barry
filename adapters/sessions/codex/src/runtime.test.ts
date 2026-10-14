import { chmodSync, statSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { codexMcpServersToToml, defaultCodexHome, ephemeralCodexHome, prepareCodexRuntime } from "./runtime.js";

// `codex app-server` appends this fixed suffix to CODEX_HOME on its own, for
// its control socket — outside any flag Barry passes. Mirrors the constant in
// runtime.ts so a change to either surfaces here as a diff, not silently.
const APP_SERVER_CONTROL_SOCKET_SUFFIX = "/app-server-control/app-server-control.sock";
const SOCKET_PATH_LIMIT = 100;

describe("Codex runtime config", () => {
  it("keeps generated configuration private on first write and reused homes", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-private-"));
    try {
      const first = prepareCodexRuntime({ codexHome, env: {} });
      expect(statSync(first.configPath).mode & 0o777).toBe(0o600);
      chmodSync(first.configPath, 0o666);
      chmodSync(codexHome, 0o755);
      prepareCodexRuntime({ codexHome, env: {} });
      expect(statSync(first.configPath).mode & 0o777).toBe(0o600);
      expect(statSync(codexHome).mode & 0o777).toBe(0o700);
    } finally { rmSync(codexHome, { recursive: true, force: true }); }
  });

  it("uses a distinct default CODEX_HOME per Barry session", () => {
    expect(defaultCodexHome("session-a")).not.toBe(defaultCodexHome("session-b"));
  });

  it("gives the same default CODEX_HOME back for the same session id", () => {
    expect(defaultCodexHome("session-a")).toBe(defaultCodexHome("session-a"));
  });

  it("leaves codex's control socket under the OS's unix socket path limit", () => {
    // Short, normal and long IDs must respect the OS socket limit; see docs/decisions/0015-verification-and-socket-invariants.md.
    for (const sessionId of ["s", "bGihMA9UBIL3V4r_69TIP", "x".repeat(200)]) {
      const socketPath = defaultCodexHome(sessionId) + APP_SERVER_CONTROL_SOCKET_SUFFIX;
      expect(socketPath.length).toBeLessThanOrEqual(SOCKET_PATH_LIMIT);
    }
  });

  it("gives an ephemeral CODEX_HOME whose control socket also fits", () => {
    const codexHome = ephemeralCodexHome();
    try {
      const socketPath = codexHome + APP_SERVER_CONTROL_SOCKET_SUFFIX;
      expect(socketPath.length).toBeLessThanOrEqual(SOCKET_PATH_LIMIT);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("writes HTTP and stdio MCP servers to Codex config.toml", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "barry-codex-test-"));

    try {
      const runtime = prepareCodexRuntime({
        codexHome,
        env: { OPENAI_API_KEY: "sk-test" },
        mcpServers: {
          barry: {
            type: "http",
            url: "http://localhost:1234/mcp",
            headers: { Authorization: "Bearer barry-secret" },
          },
          local: {
            command: "node",
            args: ["server.js"],
            env: { FOO: "bar" },
          },
        },
      });

      const config = readFileSync(runtime.configPath, "utf8");
      expect(runtime.env.CODEX_HOME).toBe(codexHome);
      expect(runtime.env.OPENAI_API_KEY).toBe("sk-test");
      expect(runtime.env.BARRY_CODEX_MCP_BARRY_BEARER_TOKEN).toBe("barry-secret");
      expect(config).toContain("[mcp_servers.barry]");
      expect(config).toContain('url = "http://localhost:1234/mcp"');
      expect(config).toContain('bearer_token_env_var = "BARRY_CODEX_MCP_BARRY_BEARER_TOKEN"');
      expect(config).toContain("[mcp_servers.local]");
      expect(config).toContain('"node", "server.js"]');
      expect(config).toContain("env_vars = [");
      expect(config).not.toContain("[mcp_servers.local.env]");
      expect(config).not.toContain('FOO = "bar"');
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("passes arbitrary HTTP headers through environment variables", () => {
    const env: Record<string, string> = {};
    const result = codexMcpServersToToml({
        remote: {
          type: "http",
          url: "https://example.com/mcp",
          headers: { "X-API-Key": "secret" },
        },
      }, env);

    expect(result.remote?.env_http_headers).toEqual({
      "X-API-Key": "BARRY_CODEX_MCP_REMOTE_HEADER_X_API_KEY",
    });
    expect(env.BARRY_CODEX_MCP_REMOTE_HEADER_X_API_KEY).toBe("secret");
  });

  it("isolates ambient skills, plugins, rules and credentials", () => {
    // auth.json IS codex's credential store; a session authenticates with the
    // identity's OPENAI_API_KEY, so the link would be exactly the undeclared
    // credential this work removed. Everything else still links.
    const root = mkdtempSync(join(tmpdir(), "barry-codex-state-test-"));
    const userHome = join(root, "user");
    const sessionHome = join(root, "session");

    try {
      mkdirSync(userHome);
      writeFileSync(join(userHome, "auth.json"), "{}");
      mkdirSync(join(userHome, "skills"));

      prepareCodexRuntime({
        codexHome: sessionHome,
        env: { CODEX_HOME: userHome },
      });

      expect(existsSync(join(sessionHome, "auth.json"))).toBe(false);
      expect(existsSync(join(sessionHome, "skills"))).toBe(false);
      expect(existsSync(join(sessionHome, "hooks.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Codex's built-in provider reads a login, not the environment, and sends no
  // credential without one (0.160.1: "401 Missing bearer").
  it("reaches codex's own vendor through a provider that reads the identity's key from the environment", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "barry-codex-test-"));
    try {
      const runtime = prepareCodexRuntime({ codexHome, env: { OPENAI_API_KEY: "sk-test" }, model: "openai/gpt-5.5" });
      const config = readFileSync(runtime.configPath, "utf8");
      expect(config).toContain('model_provider = "barry-openai"');
      expect(config).toContain('model = "gpt-5.5"');
      expect(config).toContain("[model_providers.barry-openai]");
      expect(config).toContain('env_key = "OPENAI_API_KEY"');
      expect(config).toContain('wire_api = "responses"');
      expect(runtime.env.CODEX_API_KEY).toBeUndefined();
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("runs every client's turns under Barry's policy, and carries guidance and answered model prompts when given", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "barry-codex-test-"));
    const userConfig = join(codexHome, "user-config.toml");
    writeFileSync(userConfig, '[notice.model_migrations]\n"gpt-5.5" = "gpt-6-sol"\n\n[projects."/x"]\ntrust_level = "trusted"\n');
    try {
      const runtime = prepareCodexRuntime({ codexHome, env: { OPENAI_API_KEY: "sk-test" }, instructions: "Be brief.", userConfigPath: userConfig });
      const config = readFileSync(runtime.configPath, "utf8");
      const topLevel = config.slice(0, config.search(/^\[/m));
      expect(topLevel).toContain('approval_policy = "never"');
      expect(topLevel).toContain('sandbox_mode = "danger-full-access"');
      expect(topLevel).toContain('developer_instructions = "Be brief."');
      expect(config).toContain('[notice.model_migrations]\n"gpt-5.5" = "gpt-6-sol"');
      expect(config).not.toContain('[projects."/x"]');
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("configures routed model provider and model in config.toml when endpoint is given", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "barry-codex-endpoint-test-"));

    try {
      const runtime = prepareCodexRuntime({
        codexHome,
        model: "llamacpp/default",
        endpoint: {
          baseUrl: "http://127.0.0.1:8080/v1",
          apiKey: "secret-key",
        },
      });

      const config = readFileSync(runtime.configPath, "utf8");
      expect(config).toContain('model_provider = "barry-endpoint-llamacpp"');
      expect(config).toContain('model = "default"');
      expect(config).toContain("[model_providers.barry-endpoint-llamacpp]");
      expect(config).toContain('base_url = "http://127.0.0.1:8080/v1"');
      expect(config).toContain('wire_api = "responses"');
      expect(config).toContain('env_key = "BARRY_CODEX_PROVIDER_LLAMACPP_KEY"');
      expect(runtime.env.BARRY_CODEX_PROVIDER_LLAMACPP_KEY).toBe("secret-key");
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

it("renders granted native switches while a caller denial takes shell back", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-native-config-"));
  try {
    const runtime = prepareCodexRuntime({ codexHome, allowedNativeTools: ["exec_command", "write_stdin", "view_image", "web_search"], deniedTools: ["exec_command"] });
    const config = readFileSync(runtime.configPath, "utf8");
    expect(config).toContain('web_search = "live"');
    expect(config).toContain("features.view_image = true");
    expect(config).toContain("features.shell_tool = false");
    for (const name of ["standalone_web_search", "request_permissions_tool", "sleep_tool", "memories", "agent_message_board", "send_message_to_user_async", "tool_suggest", "skill_search"]) {
      expect(config).toContain(`features.${name} = false`);
    }
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});
