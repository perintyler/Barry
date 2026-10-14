/**
 * Read-before-edit enforcement (Claude Code parity), as a tool wrapper.
 *
 * - Edit/MultiEdit on a file this session never Read → hard fail.
 * - Write to an EXISTING file this session never Read → hard fail (new paths pass).
 * - On-disk mtime differs from the recorded read → hard fail ("re-read and retry").
 * - Fails OPEN on any tracking error, and is only applied to sessions with a
 *   barrySessionId (same gating as wrapEditIntent) — stale-context edits are
 *   a shared-HTTP-server problem, which is exactly where this wrapper runs.
 *
 * After a successful edit the recorded mtime is refreshed, so a session's own
 * consecutive edits pass without re-reading.
 */

import { existsSync, statSync } from "node:fs";
import { resolveUserPath } from "@barry-rocks/sdk/tools";
import { createLogger } from "@barry-rocks/sdk/logging";
import { getSessionState } from "./session-state.js";
import type { RuntimeTool } from "./tool-runtime.js";

const log = createLogger("read-tracking", { transport: "stderr" });

const READ_TOOL = "Read";
const CHECKED_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

// Escape hatch: flip to false to warn-and-proceed instead of failing, if live
// use shows the hard check churning (e.g. sessions mid-flight over a deploy).
// Either way every violation emits a read_tracking.blocked warn line.
const ENFORCE_READ_BEFORE_EDIT = true;

function resolveTrackedPath(filePath: string): string | null {
  try {
    return resolveUserPath(filePath);
  } catch {
    return null;
  }
}

export function wrapReadTracking(tools: RuntimeTool[], sessionId: string): RuntimeTool[] {
  return tools.map((tool) => {
    if (tool.name === READ_TOOL) {
      const original = tool.handler;
      return {
        ...tool,
        handler: async (params, context) => {
          const result = await original(params, context);
          // Record AFTER success only — a failed read proves nothing.
          try {
            const filePath = params.file_path;
            if (typeof filePath === "string") {
              const resolvedPath = resolveTrackedPath(filePath);
              if (resolvedPath) {
                const fileStat = statSync(resolvedPath);
                if (fileStat.isFile()) getSessionState(sessionId).fileReads.set(resolvedPath, fileStat.mtimeMs);
              }
            }
          } catch {
            // Tracking is best-effort; the read itself already succeeded.
          }
          return result;
        },
      };
    }

    if (!CHECKED_TOOLS.has(tool.name)) return tool;

    const original = tool.handler;
    return {
      ...tool,
      handler: async (params, context) => {
        const filePath = params.file_path;
        if (typeof filePath === "string") {
          let target: { path: string; mtimeMs: number } | null | undefined;
          try {
            const resolvedPath = resolveTrackedPath(filePath);
            if (resolvedPath && existsSync(resolvedPath)) {
              const fileStat = statSync(resolvedPath);
              target = fileStat.isFile() ? { path: resolvedPath, mtimeMs: fileStat.mtimeMs } : undefined;
            } else {
              target = undefined; // new file — nothing to have read
            }
          } catch {
            target = null; // tracking broke — fail open
          }

          if (target) {
            const recordedMtimeMs = getSessionState(sessionId).fileReads.get(target.path);
            let reason: "unread" | "stale" | null = null;
            if (recordedMtimeMs === undefined) reason = "unread";
            else if (target.mtimeMs !== recordedMtimeMs) reason = "stale";

            if (reason) {
              // Every block is logged: without this line the enforcement is
              // invisible in stderr and "no rejections in the logs" proves
              // nothing (a verifier that cannot fail is worse than none).
              log.warn("read_tracking.blocked", {
                tool: tool.name,
                sessionId,
                path: target.path,
                reason,
                enforced: ENFORCE_READ_BEFORE_EDIT,
              });
            }

            if (reason === "unread" && ENFORCE_READ_BEFORE_EDIT) {
              if (tool.name === "Write") {
                throw new Error(
                  `${filePath} exists but has not been Read in this session. ` +
                    `Read it first (or choose a new path) before overwriting.`,
                );
              }
              throw new Error(
                `You must Read ${filePath} before editing it in this session. Read the file, then retry.`,
              );
            }
            if (reason === "stale" && ENFORCE_READ_BEFORE_EDIT) {
              throw new Error(
                `${filePath} has changed on disk since you last read it. ` +
                  `Re-read the file and retry with the current content.`,
              );
            }
          }
        }

        const result = await original(params, context);

        // Our own successful edit refreshes the recorded mtime.
        try {
          if (typeof filePath === "string") {
            const resolvedPath = resolveTrackedPath(filePath);
            if (resolvedPath) {
              const fileStat = statSync(resolvedPath);
              if (fileStat.isFile()) getSessionState(sessionId).fileReads.set(resolvedPath, fileStat.mtimeMs);
            }
          }
        } catch {
          // Best-effort refresh; the edit already succeeded.
        }
        return result;
      },
    };
  });
}
