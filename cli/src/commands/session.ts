import { currentTarget, assertOwnedSession } from "../target.js";
import { CliError } from "../lib/cli-error.js";
import {
  Sessions,
  listSessions,
} from "@barry-rocks/sessions-bag/client";

export async function sessionListCommand(): Promise<void> {
  // Through the seam, filtered here rather than in SQL.
  //
  // This was a raw `db.selectFrom("sessions")` against the old server
  // database, justified by a comment saying `Sessions.list()` has no status
  // filter. That was true and
  // stopped mattering: migration 041 dropped the table, so the command failed
  // outright with `relation "sessions" does not exist`.
  //
  // The seam still has no status filter, and adding one to serve a CLI listing
  // would widen an interface that five other callers share. Fetching a bounded
  // page and filtering in JS costs nothing at this size and keeps the seam
  // narrow. `active` is the closest server-side filter, so the page is already
  // small before the status check runs.
  const candidates = await listSessions({ limit: 200 });
  const rows = candidates
    .filter((r) => (r.active || r.started_at || r.last_message_at) && (r.status === "running" || r.status === "pending") && (currentTarget().kind !== "identity" || r.identity_id === Number(process.env.BARRY_IDENTITY_ID)))
    .slice(0, 50);

  if (rows.length === 0) {
    console.log("No active sessions.");
    return;
  }

  const statusColors: Record<string, string> = {
    running: "\x1b[32m",  // green
    pending: "\x1b[33m",  // yellow
  };
  const reset = "\x1b[0m";
  const dim = "\x1b[2m";
  const bold = "\x1b[1m";
  const cyan = "\x1b[36m";

  console.log(`\n${bold}Active Sessions (${rows.length})${reset}\n`);

  for (const row of rows) {
    const meta = Sessions.parseMetadata(row.metadata);
    const status = row.status as string;
    const color = statusColors[status] ?? "";
    const age = row.created_at ? timeSince(new Date(String(row.created_at))) : "";
    const dir = meta.working_directory
      ? meta.working_directory.split("/").slice(-2).join("/")
      : "";

    // Lead with the name when there is one, but keep the id on the same line —
    // it is what `barry resume` takes, so it must stay copyable.
    const shortId = row.id.slice(0, 12);
    const label = meta.name
      ? `${bold}${meta.name}${reset}  ${dim}${shortId}${reset}`
      : `${bold}${shortId}${reset}`;

    console.log(`  ${color}●${reset} ${label}  ${color}${status}${reset}${age ? `  ${dim}${age}${reset}` : ""}`);

    if (dir) {
      console.log(`    ${dim}dir:${reset} ${cyan}${dir}${reset}`);
    }

    const systemPrompt = row.system_prompt;
    if (systemPrompt) {
      const truncated = systemPrompt.length > 120 ? systemPrompt.slice(0, 120) + "…" : systemPrompt;
      console.log(`    ${dim}prompt:${reset} ${truncated}`);
    }

    console.log();
  }
}

interface SessionArchiveOptions {
  allClosed?: boolean;
}

export async function sessionArchiveCommand(id: string | undefined, options: SessionArchiveOptions): Promise<void> {
  if (options.allClosed) {
    const target = currentTarget();
    const count = target.kind === "identity" ? await (async () => {
      const rows = (await Sessions.list({ limit: 10000 })).filter(row => row.identity_id === target.binding.id && row.state === "closed");
      for (const row of rows) await Sessions.archive(row.id);
      return rows.length;
    })() : await Sessions.archiveAllClosed();
    console.log(`Archived ${count} closed session${count !== 1 ? "s" : ""}.`);
    return;
  }

  if (!id) {
    throw new CliError("Provide a session ID or use --all-closed.", 1);
  }

  let sessionId = id;
  const session = await Sessions.get(id);

  if (!session) {
    const recent = await Sessions.list({ limit: 100 });
    const match = recent.find((s) => s.id.startsWith(id));
    if (!match) {
      throw new CliError(`Session not found: ${id}`, 1);
    }
    sessionId = match.id;
  }

  const target = currentTarget();
  if (target.kind === "identity") assertOwnedSession(await Sessions.get(sessionId), target.binding.id);
  await Sessions.archive(sessionId);
  console.log(`Archived session ${sessionId.slice(0, 8)}.`);
}

function timeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
