import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Barry, isBarryError } from "@barry-rocks/sdk";
import { localConnection } from "@barry-rocks/sdk/services";
import { codexHomeRecordPath, codexHomesRoot, durableCodexHomesRoot, lockCodexHome } from "./runtime.js";

type Closure = { id: string; status: string; pinned: boolean; endedAt?: string | null };
export interface CodexRetentionReport { removed: string[]; kept: string[] }

/** Retain conversations for 30 days after closure; unknown, pinned and live rows stay. */
export async function reapCodexHomes(get: (id: string) => Promise<Closure | null>, now = Date.now()): Promise<CodexRetentionReport> {
  const report: CodexRetentionReport = { removed: [], kept: [] };
  const root = durableCodexHomesRoot();
  if (!existsSync(root)) return report;
  const cutoff = now - 30 * 86_400_000;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{12}$/.test(entry.name)) continue;
    const home = join(root, entry.name);
    let unlock: (() => void) | undefined;
    try {
      unlock = lockCodexHome(entry.name);
      const marker = JSON.parse(readFileSync(codexHomeRecordPath(entry.name), "utf8"));
      if (typeof marker.sessionId !== "string" || createHash("sha256").update(marker.sessionId).digest("hex").slice(0, 12) !== entry.name) throw new Error("unknown home owner");
      const lastUsed = Date.parse(marker.lastUsedAt);
      const session = await get(marker.sessionId);
      const ended = session?.endedAt ? Date.parse(session.endedAt) : NaN;
      if (!session || session.id !== marker.sessionId || session.pinned || !["completed", "failed", "cancelled"].includes(session.status) || !Number.isFinite(ended) || !Number.isFinite(lastUsed) || Math.max(ended, lastUsed) > cutoff) {
        report.kept.push(entry.name); continue;
      }
      const alias = join(codexHomesRoot(), entry.name);
      const aliasStat = lstatSync(alias, { throwIfNoEntry: false });
      if (aliasStat && (!aliasStat.isSymbolicLink() || realpathSync(alias) !== realpathSync(home))) throw new Error("unknown temporary home owner");
      rmSync(home, { recursive: true });
      rmSync(codexHomeRecordPath(entry.name));
      // Unlink our rendezvous only, including a dangling link after home removal.
      rmSync(alias, { force: true });
      report.removed.push(marker.sessionId);
    } catch { report.kept.push(entry.name); }
    finally { unlock?.(); }
  }
  return report;
}

/** Read closure only through public SDK handles, retaining unknown identity ownership. */
export function codexClosureLookup(client: ReturnType<typeof Barry.at>): (id: string) => Promise<Closure | null> {
  let identities: Awaited<ReturnType<typeof client.identities>> | undefined;
  return async id => {
    identities ??= await client.identities();
    for (const identity of identities) {
      try {
        const session = await client.identity(identity.id).session(id).get();
        // Public handles are identity-scoped; never accept a row owned by another identity.
        if (session.identityId === identity.id) return session;
      } catch (error) {
        if (!isBarryError(error) || error.reason !== "not_found") throw error;
      }
    }
    return null;
  };
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const client = Barry.at(await localConnection());
  console.log(JSON.stringify(await reapCodexHomes(codexClosureLookup(client))));
}
