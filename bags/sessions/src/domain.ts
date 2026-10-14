/**
 * A session and its messages as `Barry` hands them out, read from this bag's
 * rows, and the cursor a page of sessions resumes from. The sessions API
 * serves the same shapes, so a client and an in-process caller read one
 * session the same way.
 */
import { homedir } from "node:os";
import type { Message, Session } from "@barry-rocks/sdk";
import { findInstalled } from "@barry-rocks/sdk/adapters/harnesses";
import { loadAdapters } from "@barry-rocks/sdk/internal/adapters";
import { installedModels, routedVendorOf } from "@barry-rocks/sdk/adapters/models";
import { HarnessIdSchema, modelRef, parseModelRef, type HarnessId } from "@barry-rocks/sdk/ids";
import { barryAdaptersPath } from "@barry-rocks/sdk/services";
import { MessageSchema } from "@barry-rocks/sdk/internal/sessions";
import { Sessions, type ProcessRecord, type SessionRecord } from "./client/index.js";

// Read per process: a session's grants are asked on every turn and every tool approval.
let installedAdapters: ReturnType<ReturnType<typeof loadAdapters>["installed"]> | null = null;

function installed(harness: HarnessId) {
  installedAdapters ??= loadAdapters({ file: barryAdaptersPath() }).installed();
  return findInstalled(installedAdapters, harness);
}

/** A harness as the session recorded it, by the id its installed adapter answers to now. */
export function harnessOf(provider: unknown): string | undefined {
  if (typeof provider !== "string" || !provider) return undefined;
  return installed(provider)?.id ?? provider;
}

const IDENTITY_SOURCES = ["explicit", "repo", "default", "file"] as const;

function expandUserPath(path: string): string {
  return path.startsWith("~") ? path.replace("~", homedir()) : path;
}

/** The recorded harness, when it is shaped like one; a row may hold anything. */
function recordedHarness(provider: unknown): HarnessId | null {
  const parsed = HarnessIdSchema.safeParse(provider);
  return parsed.success ? parsed.data : null;
}

/**
 * The stored status, except that a closed session is always terminal: the
 * column keeps whatever the last turn wrote until something reconciles it.
 * Whether a session is live is the runtime's to say; the row alone cannot.
 */
function statusOf(row: SessionRecord): SessionRecord["status"] {
  const closed = row.active === false || row.state === "closed" || row.state === "archived";
  if (!closed) return row.status;
  return row.status === "completed" || row.status === "failed" || row.status === "cancelled" ? row.status : "completed";
}

/**
 * The model as `vendor/model`, routed the way the sessions API routes it: null
 * where the row does not say which vendor serves it, rather than a guess.
 */
function modelRefOf(harness: HarnessId | null, model: unknown, modelProvider: unknown): string | null {
  if (!harness || typeof model !== "string" || !model) return null;
  const vendorNamed = typeof modelProvider === "string" && modelProvider ? modelProvider : undefined;
  try {
    // Already a ref (`ollama/qwen3:8b`), when its prefix is a vendor this installation knows.
    const asRef = vendorNamed ? undefined : parseModelRef(model);
    if (asRef && installedModels().vendors().some((vendor) => vendor.id === asRef.vendor)) return modelRef(asRef.vendor, asRef.model);
    const record = installed(harness);
    const vendor = vendorNamed ?? (record ? routedVendorOf(record, model, installedModels().vendors())?.id : undefined) ?? record?.vendor;
    if (vendor) return modelRef(vendor, model);
    const parsed = parseModelRef(model);
    return parsed ? modelRef(parsed.vendor, parsed.model) : null;
  } catch {
    // No models installed in this process, so which vendor a bare id routes to is unknown.
    return null;
  }
}

/**
 * The process running the session's agent, as the sessions API's liveness
 * check finds it: the session's live row in the processes table, which
 * `PATCH /sessions/:id` and the reaper write, else what a row from before
 * that table kept in its metadata. The three fields are one identity, so they
 * come from one place.
 */
function processOf(row: SessionRecord, liveProcess: ProcessRecord | null): Pick<Session, "hostname" | "pid" | "pidStartedAt"> {
  if (liveProcess) return { hostname: liveProcess.hostname, pid: liveProcess.pid, pidStartedAt: liveProcess.pidStartedAt };
  const metadata = row.metadata;
  return {
    hostname: typeof metadata.hostname === "string" ? metadata.hostname : null,
    pid: typeof metadata.pid === "number" ? metadata.pid : null,
    pidStartedAt: typeof metadata.pid_started_at === "number" ? metadata.pid_started_at : null,
  };
}

/** A session row as Barry hands it out, with its live process row when it has one. */
export function sessionOf(row: SessionRecord, liveProcess: ProcessRecord | null): Session {
  const metadata = row.metadata;
  const harness = recordedHarness(metadata.provider);
  return {
    id: row.id,
    name: Sessions.getName(row),
    systemPrompt: row.system_prompt,
    summary: row.summary,
    repoPath: metadata.working_directory ? expandUserPath(metadata.working_directory) : null,
    branch: typeof metadata.git_branch === "string" ? metadata.git_branch : null,
    transcriptPath: typeof metadata.transcript_path === "string" ? metadata.transcript_path : null,
    ...processOf(row, liveProcess),
    identityId: row.identity_id,
    identitySource: IDENTITY_SOURCES.find((source) => source === metadata.barry_source) ?? null,
    status: statusOf(row),
    traits: row.traits,
    bounds: row.bounds,
    bound: row.bound,
    pinned: metadata.pinned === true,
    useWorktree: metadata.use_worktree === true,
    worktreeStatus: typeof metadata.worktree_status === "string" ? metadata.worktree_status : null,
    worktreePath: typeof metadata.worktree_path === "string" ? metadata.worktree_path : null,
    baseRepoPath: typeof metadata.base_repo_path === "string" ? expandUserPath(metadata.base_repo_path) : null,
    source: metadata.source ?? null,
    // The id as recorded (`claude`), which clients have always read, and as named now (`claude-code`).
    provider: harness,
    harness: harness === null ? null : harnessOf(harness) ?? harness,
    model: metadata.model ?? null,
    modelRef: modelRefOf(harness, metadata.model, metadata.model_provider),
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

/** A message as the store reads it back, checked against the shape the API promises. */
export function messageOf(message: Record<string, unknown>): Message {
  return MessageSchema.parse(message);
}

/**
 * Where the page after this session starts. `lastMessageAt` rides along so an
 * activity-ordered page resumes on the key it sorted by; a cursor without it
 * still decodes. The sessions API encodes its cursors the same way, so one
 * from either resumes in the other.
 */
export function encodeSessionCursor(session: SessionRecord): string {
  return Buffer.from(
    JSON.stringify({ createdAt: session.created_at, id: session.id, lastMessageAt: session.last_message_at }),
    "utf8",
  ).toString("base64url");
}

export function decodeSessionCursor(
  value: unknown,
): { createdAt: string; id: string; lastMessageAt?: string | null } | null {
  if (typeof value !== "string" || value.length > 512) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const cursor = parsed as Record<string, unknown>;
    return typeof cursor.createdAt === "string" && typeof cursor.id === "string"
      ? {
          createdAt: cursor.createdAt,
          id: cursor.id,
          lastMessageAt: typeof cursor.lastMessageAt === "string" ? cursor.lastMessageAt : null,
        }
      : null;
  } catch {
    return null;
  }
}
