import { describe, expect, it } from "vitest";
import { existsSync, statSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mergeBounds, resolveNativeTools } from "@barry-rocks/sdk/bounds";

import { parseManifest } from "@barry-rocks/sdk/bags";
import { NATIVE_TOOLS } from "./native-tools.js";
import { writeCursorSessionWorkspace } from "./workspace.js";

const cursorManifest = parseManifest(new URL("../", import.meta.url).pathname)!;
const cursorBounds = cursorManifest.bounds!;
const bound = mergeBounds({ network: { deny: ["*"] } }, cursorBounds["cursor:no-file-writes"]?.bound);
const nativeToolDenials = () => resolveNativeTools(bound, [], { id: "cursor", tools: NATIVE_TOOLS, bag: { manifest: cursorManifest } }, "guest").denied;

describe("writeCursorSessionWorkspace", () => {
  it("writes project .cursor/mcp.json, hooks.json, and returns server names", () => {
    const { workspaceDir, selectedServers } = writeCursorSessionWorkspace({
      mcpServers: {
        barry: { type: "http", url: "http://localhost:9/mcp?sessionId=s1" },
        linear: { type: "http", url: "http://localhost:9/mcp/ns/linear?sessionId=s1" },
      },
    });
    try {
      const mcpPath = join(workspaceDir, ".cursor", "mcp.json");
      const hooksPath = join(workspaceDir, ".cursor", "hooks.json");
      expect(existsSync(mcpPath)).toBe(true);
      expect(existsSync(hooksPath)).toBe(true);
      expect(statSync(join(workspaceDir, ".cursor")).mode & 0o777).toBe(0o700);
      for (const file of [mcpPath, hooksPath, join(workspaceDir, ".cursor", "cli.json")]) expect(statSync(file).mode & 0o777).toBe(0o600);
      const written = JSON.parse(readFileSync(mcpPath, "utf-8"));
      expect(Object.keys(written.mcpServers)).toEqual(["barry", "linear"]);
      expect(selectedServers).toEqual(["barry", "linear"]);
      expect(written.mcpServers.barry.url).toContain("sessionId=s1");

      // Tracker hooks remain installed when their old directory is absent; see docs/decisions/0021-telemetry-polling-and-adapter-regressions.md.
      const hooks = JSON.parse(readFileSync(hooksPath, "utf-8"));
      expect(hooks.version).toBe(1);
      // Mandatory enforcement is installed even without bag tracking hooks.
      expect(hooks.hooks.preToolUse[0].failClosed).toBe(true);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("writes the scope's native tool denials into the config Cursor enforces", () => {
    // A scoped session's whole point is that the native tools are gone. This
    // list reached Claude's settings.json and stopped there, so the same scope
    // left a Cursor session holding native Bash.
    const { workspaceDir, unenforceableDenials } = writeCursorSessionWorkspace(
      { mcpServers: {} },
      { deniedTools: [...nativeToolDenials(), "Glob"] },
    );
    try {
      const cli = JSON.parse(readFileSync(join(workspaceDir, ".cursor", "cli.json"), "utf-8"));
      expect(cli.permissions.deny).toEqual(expect.arrayContaining([
        "Shell(*)",
        "WebFetch(*)",
        "Write(*)",
      ]));
      // Cursor's inventory includes Glob, which has no permission kind.
      expect(unenforceableDenials).toContain("Glob");
      expect(JSON.parse(readFileSync(join(workspaceDir, ".cursor", "hooks.json"), "utf-8")).hooks.preToolUse[0].failClosed).toBe(true);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("enforces denials without a native permission kind through the mandatory gate", () => {
    const { workspaceDir, unenforceableDenials } = writeCursorSessionWorkspace(
      { mcpServers: {} },
      { deniedTools: ["Bash", "Glob", "LS"] },
    );
    try {
      expect(unenforceableDenials).toContain("Glob");
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});

it("granted reads remove the Read deny while preserving caller denials and uncontrolled reporting", () => {
  const { workspaceDir, unenforceableDenials } = writeCursorSessionWorkspace({ mcpServers: {} }, {
    allowedNativeTools: ["Read", "Grep", "List"], deniedTools: ["Grep"],
  });
  try {
    const cli = JSON.parse(readFileSync(join(workspaceDir, ".cursor", "cli.json"), "utf8"));
    expect(cli.permissions.deny).not.toContain("Read(*)");
    expect(cli.permissions.deny).toContain("Shell(*)");
    expect(cli.permissions.deny).toContain("Write(*)");
    expect(unenforceableDenials).toEqual(expect.arrayContaining(["Grep", "Glob", "Fetch", "SemanticSearch"]));
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});
