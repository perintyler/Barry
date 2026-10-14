/**
 * Pre-accept only a directory the caller explicitly attests Barry created.
 * Canonical cwd must match that attestation. Atomic rename protects readers,
 * but cannot coordinate with independent vendor writes to the shared file.
 * Rationale: docs/decisions/0024-claude-created-directory-trust.md.
 */
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where claude keeps its one global, per-directory trust record. */
function claudeConfigPath(): string {
  return join(homedir(), ".claude.json");
}

/**
 * Mark `cwd` trusted in `~/.claude.json`, so `claude` skips its interactive
 * dialog there only when the creation attestation matches. Never throws.
 */
export function acceptFolderTrust(cwd: string, createdDirectory?: string): void {
  if (typeof createdDirectory !== "string" || !createdDirectory) return;
  try {
    // realpath, because claude canonicalises the cwd before its own lookup —
    // an un-resolved path (every macOS /tmp path is a symlink) never matches.
    const path = realpathSync(cwd);
    if (path !== realpathSync(createdDirectory)) return;
    const configPath = claudeConfigPath();
    const config = readConfig(configPath);
    const projects = isRecord(config.projects) ? config.projects : {};
    const project = isRecord(projects[path]) ? projects[path] : {};

    if (project.hasTrustDialogAccepted === true) return;

    writeConfig(configPath, {
      ...config,
      projects: { ...projects, [path]: { ...project, hasTrustDialogAccepted: true } },
    });
  } catch {
    // No ~/.claude.json, an unreadable one, or a write race with another
    // process: the dialog still shows, which is the pre-existing behavior.
  }
}

function readConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return isRecord(parsed) ? parsed : {};
}

/** Write then rename, so a reader (claude itself, mid-launch) never sees a half-written file. */
function writeConfig(path: string, config: Record<string, unknown>): void {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  renameSync(temporaryPath, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
