import { hostname, userInfo } from "os";
import { Barry, isBarryError, type Bound } from "@barry-rocks/sdk";
import {
  getSession as _getSession,
  createSession as _createSession,
  updateSession as _updateSession,
  endSession as _endSession,
  deleteSession as _deleteSession,
  getSessionMessageCount as _getSessionMessageCount,
  getProviderSessionsBySession as _getProviderSessionsBySession,
  createProviderSession as _createProviderSession,
  type SessionMetadata,
} from "../client/index.js";

export interface StartSessionInput {
  session_id: string;
  provider_session_id?: string | null;
  provider?: string | null;
  /**
   * Model this session runs on. Recorded in metadata so message provenance
   * can resolve it — previously only session-runtime wrote provider/model, and
   * only on the API path, so the ~97% of sessions created by the CLI had no
   * provenance at all.
   */
  model?: string | null;
  model_provider?: string | null;
  /**
   * How Barry was attached: `hosted`, `guest-plus`, or `guest`.
   *
   * Stored because it is the only record of what this session's guarantees
   * actually were — the modes differ in what Barry could capture, gate and
   * deliver, and re-deriving it later from what the adapter declares TODAY
   * would give the wrong answer for any session that ran before a declaration
   * changed. Null for a session Barry did not launch: a foreign guest has no
   * mode Barry chose, and inventing one would misreport its guarantees.
   */
  mode?: string | null;
  /** What the mode guaranteed for this launch, which can be less than its declaration when a side door would not open. */
  guarantees?: SessionMetadata["guarantees"];
  cwd?: string | null;
  directive?: string | null;
  transcript_path?: string | null;
  permission_mode?: string | null;
  source?: string | null;
  identity_id?: number | null;
  name?: string | null;
  web_enabled?: boolean;
  /**
   * Named bounds applied on session creation or resume.
   * Resolved and pinned into `sessions.bound` at session start.
   */
  bounds?: string[];
  bags?: string[];
  status?: "pending" | "running";
}

export interface EndSessionInput {
  session_id: string;
  reason?: string | null;
}

function resolveEnvBarryId(): number | null {
  if (!process.env.BARRY_ID) return null;
  const parsed = parseInt(process.env.BARRY_ID, 10);
  return isNaN(parsed) ? null : parsed;
}

/**
 * Drop an identity_id that doesn't exist in the current DB. Guards against a
 * stale BARRY_ID env var (e.g. a dev shell pointed at a prod-only barry)
 * linking the session to an identity that isn't there — the session should
 * still start, just without a barry link.
 *
 * Only called on the insert path, and only queries when a identity_id is
 * actually present, so it adds no cost to session updates/resumes or to
 * barry-less session creation.
 */
async function validateBarryId(identityId: number | null | undefined): Promise<number | undefined> {
  if (identityId == null) return undefined;
  try {
    // Only the id the identity answers to now; a stale one names nothing.
    return (await Barry.identity(identityId).get()).id === identityId ? identityId : undefined;
  } catch (error) {
    if (isBarryError(error) && (error.reason === "not_found" || error.reason === "forbidden")) return undefined;
    throw error;
  }
}

function plainBound(bound: Bound | null | undefined): Record<string, unknown> | null {
  if (!bound || Object.keys(bound).length === 0) return null;
  return Object.fromEntries(Object.entries(bound));
}

/**
 * Start (or resume) a session. Upserts the Barry session row and optionally
 * creates a provider_sessions row linking the SDK runtime ID.
 *
 * Used by:
 * - SessionStart hook (CLI) — creates session + provider_session
 * - session-runtime (web) — creates session, links provider on init event
 * - CLI pre-spawn — creates session before agent launch
 */
export async function startSession(input: StartSessionInput): Promise<void> {
  const existing = await _getSession(input.session_id);
  const inputBags = input.bags;
  if (existing) {
    const bounds = [...new Set([...(existing.bounds ?? []), ...(input.bounds ?? [])])];
    const shouldResolveBound = input.bounds !== undefined || existing.bound === null;
    const resolvedBound = shouldResolveBound
      ? await Barry.bound(existing.identity_id ?? input.identity_id ?? null, bounds)
      : (existing.bound as Bound | null);
    const metadataUpdates: Partial<SessionMetadata> = {};
    if (input.cwd) metadataUpdates.working_directory = input.cwd;
    if (input.directive) metadataUpdates.directive = input.directive;
    if (input.transcript_path) metadataUpdates.transcript_path = input.transcript_path;
    if (input.permission_mode) metadataUpdates.permission_mode = input.permission_mode;
    if (input.provider) metadataUpdates.provider = input.provider;
    if (input.model) metadataUpdates.model = input.model;
    if (input.model_provider) metadataUpdates.model_provider = input.model_provider;
    if (input.mode) metadataUpdates.mode = input.mode;
    if (input.guarantees) metadataUpdates.guarantees = input.guarantees;
    if (input.name) metadataUpdates.name = input.name;

    await _updateSession(input.session_id, {
      bounds,
      ...(shouldResolveBound ? { bound: plainBound(resolvedBound) } : {}),
      ...(inputBags !== undefined ? { bags: inputBags } : {}),
      active: true,
      state: "open",
      ended_at: null,
      status: input.status ?? "running",
      ...(Object.keys(metadataUpdates).length > 0
        ? { metadata: { ...existing.metadata, ...metadataUpdates } }
        : {}),
    });
  } else {
    const requestedBarryId = input.identity_id !== undefined ? input.identity_id : resolveEnvBarryId();
    const identityId = await validateBarryId(requestedBarryId);
    const bounds = input.bounds ?? [];
    const bags = inputBags ?? [];
    const resolvedBound = await Barry.bound(identityId ?? null, bounds);
    await _createSession({
      id: input.session_id,
      active: true,
      state: "open",
      agent_token: null,
      status: input.status ?? "running",
      identity_id: identityId ?? undefined,
      bounds,
      bound: plainBound(resolvedBound),
      bags,
      metadata: {
        working_directory: input.cwd ?? null,
        git_branch: null,
        git_remote: null,
        transcript_path: input.transcript_path ?? null,
        permission_mode: input.permission_mode ?? null,
        source: input.source ?? null,
        directive: input.directive ?? null,
        hostname: hostname(),
        user: userInfo().username,
        name: input.name ?? null,
        web_enabled: input.web_enabled ?? true,
        provider: input.provider ?? null,
        model: input.model ?? null,
        model_provider: input.model_provider ?? null,
        mode: input.mode ?? null,
        ...(input.guarantees ? { guarantees: input.guarantees } : {}),
      } satisfies SessionMetadata,
    });
  }

  if (input.provider_session_id) {
    await _createProviderSession({
      session_id: input.session_id,
      provider: input.provider ?? "claude",
      provider_session_id: input.provider_session_id,
    });
  }
}

/**
 * End a session. Ends the Barry session and any active provider sessions.
 */
export async function endSession(input: EndSessionInput): Promise<void> {
  const messageCount = await _getSessionMessageCount(input.session_id);
  if (messageCount === 0) {
    const session = await _getSession(input.session_id);
    const hasDirective = Boolean(session?.system_prompt?.trim());
    const hasConversation = (await _getProviderSessionsBySession(input.session_id)).length > 0;
    if (!hasDirective && !hasConversation) {
      await _deleteSession(input.session_id);
      return;
    }
  }
  await _endSession(input.session_id, input.reason ?? null);
}
