import type { Request } from "express";
import type { RequestAuthorizationOptions } from "@barry-rocks/sdk/internal/auth";
import { hasIdentityGrant, type AuthPrincipal } from "@barry-rocks/sdk/internal/auth";
import { access, identityRecords } from "@barry-rocks/identities-bag";
import { getSession } from "@barry-rocks/sessions-bag/client";

const SESSION_PATH = /^\/api\/v1\/sessions\/([A-Za-z0-9_-]{1,128})(?:\/(messages|context|changes)(?:\/([1-9][0-9]*)\/detail)?)?\/?$/;
const RESERVED_IDS = new Set(["picker", "search", "start", "end", "invalidate-tools"]);

export async function authorizeSessionRead(principal: AuthPrincipal, sessionId: string, signal: AbortSignal): Promise<boolean> {
  if (principal.kind === "installation") return true;
  const session = await getSession(sessionId);
  signal.throwIfAborted();
  if (!session || session.identity_id === null || !hasIdentityGrant(principal, session.identity_id)
    || (session.user_id !== null && session.user_id !== principal.actorId)) return false;
  const actorId = await identityRecords.actorOf(session.identity_id);
  signal.throwIfAborted();
  return actorId === principal.actorId && Boolean(await access.revalidate(principal));
}

export function sessionRequestAuthorization(): RequestAuthorizationOptions {
  return {
    verifyCredential: access.verifyCredential,
    policy: request => {
      if (request.method !== "GET") return null;
      if (/^\/api\/v1\/sessions\/?$/.test(request.path)) return {
        scopes: ["sessions:read"],
        authorize: async (principal, _request, signal) => {
          if (principal.kind !== "device") return false;
          const owners = await Promise.all(principal.identityIds.map(id => identityRecords.actorOf(id)));
          signal.throwIfAborted();
          return owners.every(actorId => actorId === principal.actorId) && Boolean(await access.revalidate(principal));
        },
      };
      const events = /^\/api\/v2\/sessions\/([A-Za-z0-9_-]{1,128})\/events\/?$/.exec(request.path);
      const match = events ?? SESSION_PATH.exec(request.path);
      if (!match || RESERVED_IDS.has(match[1]) || (match[3] && match[2] !== "messages")) return null;
      const sessionId = match[1];
      return {
        scopes: events ? ["sessions:read", "events:read", "events:subscribe"] : ["sessions:read"],
        authorize: (principal, _request, signal) => authorizeSessionRead(principal, sessionId, signal),
      };
    },
  };
}

export function requestSessionId(request: Request): string | undefined {
  const pathId = /^\/api\/v[12]\/sessions\/([^/]+)/.exec(request.path)?.[1];
  // Device scope is bound to the authorized route, never a body/query partition override.
  if (request.authPrincipal?.kind === "device") return pathId;
  const candidate: unknown = request.body?.sessionId ?? request.body?.session_id ?? request.body?.caller_session_id ?? request.query.session_id ?? pathId;
  return typeof candidate === "string" ? candidate : undefined;
}
