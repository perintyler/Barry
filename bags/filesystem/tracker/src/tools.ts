import { Barry, BarryError } from "@barry-rocks/sdk";
import { connectLocal } from "@barry-rocks/sdk/internal/client";

import { z } from "zod";
import { getDbPath } from "./db.js";
import { pruneChanges } from "./retention.js";
import { ChangesService } from "./changes-service.js";

let service: ChangesService | null = null;

function getService(): ChangesService {
  if (!service) service = new ChangesService();
  return service;
}

export const changesStatus = Barry.Tool({
  namespace: "filesystem",
  access: "read",
  name: "status",
  description: "Check the status of the changes tracking service and get statistics about recorded code changes",
  schema: {},
  handler: async () => {
    const stats = await getService().getStats();
    return { ok: true, store: getDbPath(), stats };
  },
});

export const listChanges = Barry.Tool({
  namespace: "filesystem",
  access: "read",
  name: "list_changes",
  description: "List code changes made by the agent with optional filters. Returns recent changes across sessions.",
  schema: {
    limit: z.number().optional().default(50).describe("Max changes to return (default: 50)"),
    session_id: z.string().optional().describe("Filter by session ID"),
    file_path: z.string().optional().describe("Filter by file path (partial match)"),
    tool: z.enum(["Edit", "MultiEdit", "Write"]).optional().describe("Filter by tool type"),
  },
  handler: async ({ limit, session_id, file_path, tool }) => {
    return getService().listChanges({ limit, session_id, file_path, tool });
  },
});

export const getChangesForSession = Barry.Tool({
  namespace: "filesystem",
  access: "read",
  name: "get_changes_for_session",
  description: "Get all code changes made during a specific session",
  schema: {
    session_id: z.string().describe("The session ID to get changes for"),
  },
  handler: async ({ session_id }) => {
    return getService().getChangesForSession(session_id);
  },
});

export const getChangesForFile = Barry.Tool({
  namespace: "filesystem",
  access: "read",
  name: "get_changes_for_file",
  description: "Get the change history for a specific file path",
  schema: {
    file_path: z.string().describe("The exact file path to get history for"),
    limit: z.number().optional().default(50).describe("Max changes to return"),
  },
  handler: async ({ file_path, limit }) => {
    return getService().getChangesForFile(file_path, limit);
  },
});

export const searchChanges = Barry.Tool({
  namespace: "filesystem",
  access: "read",
  name: "search_changes",
  description: "Search through code changes by content. Searches both old and new content.",
  schema: {
    query: z.string().describe("Text to search for in change content"),
    limit: z.number().optional().default(50).describe("Max results to return"),
  },
  handler: async ({ query, limit }) => {
    return getService().searchChanges(query, limit);
  },
});

export const getChangeStats = Barry.Tool({
  namespace: "filesystem",
  access: "read",
  name: "get_change_stats",
  description: "Get aggregate statistics about code changes: total count, changes by tool type, most active sessions, most modified files",
  schema: {},
  handler: async () => {
    return getService().getStats();
  },
});

export const getChange = Barry.Tool({
  namespace: "filesystem",
  access: "read",
  name: "get_change",
  description: "Get a specific change by ID with full content details",
  schema: {
    id: z.string().describe("The change ID"),
  },
  handler: async ({ id }) => {
    const change = await getService().getChange(id);
    if (!change) throw new Error("Change not found");
    return change;
  },
});

export const prune = Barry.Tool({
  namespace: "filesystem",
  access: "write",
  name: "prune",
  description: "Prune changes older than 90 days from confirmed closed, unpinned sessions; keep unknown sessions",
  schema: {},
  handler: async (_params, context) => {
    if (context?.sessionId || process.env.BARRY_SESSION_ID) throw new BarryError("forbidden", "Tracker pruning is installation maintenance; sessions cannot prune other sessions' history");
    const client = await connectLocal();
    return pruneChanges(id => client.sessions.get(id));
  },
});
