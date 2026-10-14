import { Barry, BarryError } from "@barry-rocks/sdk";
import type { ToolContext } from "@barry-rocks/sdk/tools";
import { sessionIdentity } from "@barry-rocks/sdk/stores";
import { readLocalIdentities } from "@barry-rocks/sdk/internal/nodes";
import { z } from "zod";

function asking(context: ToolContext | undefined, write = false) {
  const id = context?.sessionId ?? process.env.BARRY_SESSION_ID;
  if (!id) return Barry;
  // A session's store partition is named by its identity's UUID; the identities
  // subject lets a session read only an identity it names by name or id.
  const partition = sessionIdentity(id);
  const identity = partition === undefined ? undefined : readLocalIdentities().get(partition);
  if (identity !== undefined) return Barry.as({ kind: "session", identity, sessionId: id });
  if (write) throw new BarryError("forbidden", "cannot control services for a session whose identity is unknown");
  return Barry;
}

export const servicesList = Barry.Tool({
  namespace: "mcp", name: "services_list", access: "read",
  description: "List this instance's managed services and their process and health observations.",
  schema: {},
  handler: async (_params, context) => asking(context).services(),
});

export const servicesStatus = Barry.Tool({
  namespace: "mcp", name: "services_status", access: "read",
  description: "Observe one managed service by its service key.",
  schema: { service: z.string().min(1).describe("Service key, such as sessions.api.") },
  handler: async ({ service }, context) => asking(context).service(service).get(),
});

export const servicesRestart = Barry.Tool({
  namespace: "mcp", name: "services_restart", access: "write",
  description: "Restart one managed service. Restarting sessions.api ends every running turn. mcp.server cannot restart itself this way; use barry service restart mcp.server in the terminal.",
  schema: { service: z.string().min(1).describe("Service key to restart.") },
  handler: async ({ service }, context) => asking(context, true).service(service).restart(),
});
