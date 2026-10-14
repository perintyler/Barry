/** Resolve provider session ids from provider_sessions rather than an unwritten metadata field so transcript readers can locate their source; see docs/decisions/0013-session-store-and-mcp-admission.md. */

export interface SweepSession {
  id: string;
  provider: string;
  providerSessionId?: string;
  cwd?: string;
  metadata: Record<string, unknown>;
  host: "hosted" | "guest";
}

/** Read provider and cwd from the flat active-session mapping and treat absent hosted-mode evidence as unknown; see docs/decisions/0013-session-store-and-mcp-admission.md. */
interface SessionRow {
  id: string;
  provider?: string | null;
  working_directory?: string | null;
}

interface ProviderSessionRow {
  provider: string;
  provider_session_id?: string | null;
}

/**
 * Build one sweep session, resolving its provider session id from the
 * `provider_sessions` rows rather than from metadata.
 */
export async function toSweepSession(
  session: SessionRow,
  providerSessionsFor: (sessionId: string) => Promise<ProviderSessionRow[]>,
): Promise<SweepSession> {
  const provider = session.provider ?? "";

  const providerSessionId = (await providerSessionsFor(session.id)).find(
    (ps) => ps.provider === provider && ps.provider_session_id,
  )?.provider_session_id;

  return {
    id: session.id,
    provider,
    ...(providerSessionId ? { providerSessionId } : {}),
    ...(session.working_directory ? { cwd: session.working_directory } : {}),
    metadata: {},
    // See the note on SessionRow: `mode` is not carried on the flat session, and
    // "not known to be hosted" is the safe direction.
    host: "guest",
  };
}
