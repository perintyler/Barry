/**
 * What an identity change does besides the write: announce it on the realtime
 * bus, and re-scope running sessions when its grants changed. Inside the
 * operations, so a change made from the terminal reaches live sessions exactly
 * as one made over HTTP does.
 *
 * Fire-and-forget: the change is durable before these run, so a failure is
 * logged, never returned. A test or a machine with no services gets a log line.
 */
import { createLogger } from "@barry-rocks/sdk/logging";
import { getServiceUrl } from "@barry-rocks/sdk/services";
import { announce } from "@barry-rocks/sdk/events";
import { resolveForeignKeyId } from "../store/identity-files.js";
import type { IdentityRecord } from "../store/identities.js";

const log = createLogger("barry-identities");

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function secretHeader(): Record<string, string> {
  return process.env.BARRY_SECRET ? { authorization: `Bearer ${process.env.BARRY_SECRET}` } : {};
}

/**
 * Put an identity change on the realtime bus, through the bus seam: from a
 * process other than the bus owner an in-process publish would reach nobody
 * and look exactly like one that worked.
 */
export function announceIdentity(id: string | number, kind: "created" | "updated" | "deleted"): void {
  let baseUrl: string;
  try {
    baseUrl = `${getServiceUrl("api")}/api/v1`;
  } catch (error) {
    log.warn("identities.announce_failed", { id: String(id), kind, reason: failure(error) });
    return;
  }
  void announce({ baseUrl, path: "/identities/announce", topic: "identities", id: String(id), kind })
    .then((result) => {
      if (result.ok) return;
      // No bus to reach is how a terminal edit with Barry's services stopped
      // looks; the change is in identity.yaml either way, and a client reads
      // it on its next poll. A bus that answered and refused is worth a warning.
      const unreachable = /fetch failed|ECONNREFUSED|BARRY_SECRET not set/.test(result.reason);
      const context = { id: String(id), kind, reason: result.reason };
      if (unreachable) log.debug("identities.announce_failed", context);
      else log.warn("identities.announce_failed", context);
    })
    .catch((error: unknown) => log.warn("identities.announce_failed", { id: String(id), kind, reason: failure(error) }));
}

/**
 * Tell running sessions that an identity's grants (bags or traits) changed.
 *
 * Two channels: the MCP server's `/refresh-tools` re-scopes live transports and
 * pushes `tools/list_changed`; the sessions API's `invalidate-tools` rebuilds
 * SDK-hosted sessions' connections on their next turn, which also reaches
 * clients that ignore the push (claude-code#78208). Sessions reference the row
 * id, so a directory identity is resolved to its row first.
 */
export function refreshLiveSessions(identity: IdentityRecord, actorId?: number): void {
  void (async () => {
    let identityId: number | null = null;
    try {
      identityId = await resolveForeignKeyId(identity, actorId != null ? { actorId } : {});
    } catch {
      identityId = null;
    }
    if (identityId == null) {
      log.info("identities.grant_refresh_skipped", { identity: identity.name, reason: "no row, so no session references it" });
      return;
    }
    const body = JSON.stringify({ identityId: String(identityId) });
    for (const [event, url] of [
      ["identities.grant_refresh", () => `${getServiceUrl("mcpBarry")}/refresh-tools`],
      ["identities.grant_invalidate", () => `${getServiceUrl("api")}/api/v1/sessions/invalidate-tools`],
    ] as const) {
      try {
        const response = await fetch(url(), {
          method: "POST",
          headers: { "content-type": "application/json", ...secretHeader() },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        const result = await response.json().catch(() => null) as Record<string, unknown> | null;
        log.info(event, { identityId, status: response.status, sessions: result?.sessions, invalidated: result?.invalidated });
      } catch (error) {
        log.warn(`${event}_failed`, { identityId, error: failure(error) });
      }
    }
  })();
}
