import { allowedNative, disallowedTools } from "./native-tools.js";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { barryCacheDir, writePrivateFile } from "@barry-rocks/sdk/services";
import { join } from "node:path";
import { setupGating } from "./hooks.js";
import { antigravityAuth, cachedSignInPath } from "./credential.js";
import type { SessionConfig } from "@barry-rocks/sdk/sessions";

export interface WorkspacePlan {
  workspaceDir: string;
}

/** A conversation’s home survives process release, close and restart. */
export function antigravityHome(sessionId: string): string {
  return join(barryCacheDir(), "antigravity-homes", createHash("sha256").update(sessionId).digest("hex").slice(0, 12));
}

export function writeAntigravityWorkspace(config: SessionConfig, structured = false, signInPath = cachedSignInPath()): WorkspacePlan {
  const workspaceDir = antigravityHome(config.sessionId);
  const auth = antigravityAuth(config.env);
  mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
  const agentsDir = join(workspaceDir, ".agents");
  mkdirSync(agentsDir, { recursive: true });

  const cliDir = join(workspaceDir, ".gemini", "antigravity-cli");
  mkdirSync(cliDir, { recursive: true });
  const trustedWorkspaces = [workspaceDir, config.cwd, ...(config.projectRoots ?? [])];
  // modelProvider "gemini" makes agy take GEMINI_API_KEY and skip sign-in.
  // On the account path it is left out, and the Mac's cached sign-in is
  // copied in: agy reads it from the session's HOME, and it is copied on
  // every start because agy refreshes it in place and the Mac's copy is the
  // one the user keeps signed in.
  writePrivateFile(
    join(cliDir, "settings.json"),
    JSON.stringify(
      {
        ...(auth === "api-key" ? { modelProvider: "gemini" } : {}),
        allowNonWorkspaceAccess: true,
        trustedWorkspaces,
      },
      null,
      2,
    ),
  );
  if (auth === "google-account") {
    const target = join(cliDir, "antigravity-oauth-token");
    copyFileSync(signInPath, target);
    chmodSync(target, 0o600);
  }

  {
    const mcpServers: Record<string, unknown> = {};
    for (const [name, server] of Object.entries(config.mcpServers)) {
      if (!server.type || server.type === "stdio") {
        const stdio = server as { command: string; args?: string[]; env?: Record<string, string> };
        mcpServers[name] = {
          command: stdio.command,
          ...(stdio.args?.length ? { args: stdio.args } : {}),
          ...(stdio.env && Object.keys(stdio.env).length > 0 ? { env: stdio.env } : {}),
        };
      } else if (server.type === "http" || server.type === "sse") {
        const http = server as { url: string; headers?: Record<string, string> };
        mcpServers[name] = {
          serverUrl: http.url,
          ...(http.headers ? { headers: http.headers } : {}),
        };
      }
    }
    // It holds the Barry MCP server's bearer token. A home is kept between
    // starts and mode applies only to a file being created, so set it again.
    const mcpConfig = join(agentsDir, "mcp_config.json");
    writePrivateFile(mcpConfig, JSON.stringify({ mcpServers }, null, 2));
  }

  writePrivateFile(join(agentsDir, "hooks.json"), "{}");
  setupGating(workspaceDir, disallowedTools(config), Object.keys(config.mcpServers ?? {}), structured, allowedNative(config));

  const systemPrompt = config.systemPrompt
    ? `${config.systemPrompt}\n\n## Working Directory\n\nThe target repository for this session is \`${config.cwd}\`. Run commands and edit files in that repository directory.\n`
    : `## Working Directory\n\nThe target repository for this session is \`${config.cwd}\`. Run commands and edit files in that repository directory.\n`;

  writePrivateFile(join(workspaceDir, "AGENTS.md"), systemPrompt);
  writePrivateFile(join(workspaceDir, "GEMINI.md"), systemPrompt);

  rmSync(join(agentsDir, "skills"), { recursive: true, force: true });
  if (config.pluginDirs && config.pluginDirs.length > 0) {
    const skillsDir = join(agentsDir, "skills");
    mkdirSync(skillsDir, { recursive: true });
    for (const [index, pluginDir] of config.pluginDirs.entries()) {
      if (existsSync(pluginDir)) {
        try {
          cpSync(pluginDir, join(skillsDir, `mounted-skills-${index}`), { recursive: true });
        } catch {
          /* best effort copy */
        }
      }
    }
  }

  return { workspaceDir };
}
