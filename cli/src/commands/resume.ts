import { findInstalled } from "@barry-rocks/sdk/adapters/harnesses";
import { FALLBACK_HARNESS } from "@barry-rocks/sdk/internal/identities";
import { installedHarnesses } from "../lib/harness-flags.js";
import { currentScope, assertOwnedSession } from "../scope.js";
import { existsSync } from "fs";
import { select } from "@inquirer/prompts";
import {
  getSession,
  getProviderSessionsBySession,
  listSessions,
} from "@barry-rocks/sessions-bag/client";
import { startCommand, type StartOptions } from "./start.js";

interface SessionMetadata {
  working_directory?: string;
  name?: string;
  directive?: string;
  source?: string;
  [key: string]: unknown;
}

function parseMetadata(raw: unknown): SessionMetadata {
  if (!raw) return {};
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return raw as SessionMetadata;
}

export interface ResumeOptions {
  harness?: string;
  last?: boolean;
  barry?: string;
  zai?: boolean;
  ollama?: boolean;
  llamacpp?: boolean;
  modelProvider?: string;
  ui?: string;
  noUi?: boolean;
  // Capability escape hatches. Resume shows the trait picker pre-checked with
  // the previous session's traits; any of these skip it (see start.ts).
  traits?: string;
  all?: boolean;
  read?: boolean;
  none?: boolean;
  prompt?: string;
  /** Session display name (-N/--session-name); renames the resumed session. */
  sessionName?: string;
}

/**
 * The model provider — and model — a resumed session must return to.
 *
 * An explicit flag wins; otherwise the ones the session recorded. Without the
 * recorded provider, resuming a session that ran a custom Ollama model sends
 * the conversation to Anthropic: the custom id names no provider on its own.
 * Without the recorded model it stays on Ollama but switches to the provider's
 * default model mid-conversation — resume takes no `-m`, so nothing else
 * would bring it back.
 */
export function resumedModelProvider(options: ResumeOptions, metadata: unknown): Partial<StartOptions> {
  if (options.modelProvider || options.zai || options.ollama || options.llamacpp) return {};
  const recorded = parseMetadata(metadata);
  const provider = recorded.model_provider;
  const model = recorded.model;
  return { ...(typeof provider === "string" && provider ? { modelProvider: provider } : {}), ...(typeof model === "string" && model ? { model } : {}) };
}

/** Ask the user to select a resumable session without inferring one from cwd; see docs/decisions/0019-cli-checkouts-and-session-selection.md. */
async function pickSessionToResume(): Promise<{ id: string; traits: string[] } | undefined> {
  // `active: false` is the seam's equivalent of the old `active != true`. The
  // `state in (open, closed)` filter is applied here because the seam has no
  // state filter, and archived sessions should not be offered for resume.
  const page = await listSessions({ limit: 60, active: false });
  const rows = page
    .filter((r) => (r.state === "open" || r.state === "closed") && (currentScope().kind !== "identity" || r.identity_id === Number(process.env.BARRY_IDENTITY_ID)))
    .slice(0, 20);

  if (rows.length === 0) return undefined;

  const choices = rows.map((row) => {
    const meta = parseMetadata(row.metadata);
    const label = (meta.name as string)
      || meta.directive?.slice(0, 50)
      || (row.system_prompt)?.slice(0, 50)
      || (row.id).slice(0, 8);
    const source = meta.source === "cli" ? "CLI" : meta.source === "cursor" ? "Cursor" : "Web";
    const dir = meta.working_directory?.split("/").slice(-2).join("/") ?? "";
    const age = row.created_at ? timeSince(new Date(String(row.created_at))) : "";

    return {
      name: `${label} [${source}] ${dir}${age ? ` — ${age}` : ""}`,
      value: row.id,
      description: `[${row.status}] ${(row.id).slice(0, 8)}`,
    };
  });

  const id = await select({ message: "Resume session", choices });
  const selected = rows.find((r) => r.id === id);
  return { id, traits: (selected?.traits as string[]) ?? [] };
}

/** The capability/prompt flags resume forwards verbatim to startCommand. */
function passthroughOptions(options: ResumeOptions): Partial<StartOptions> {
  return {
    ...(options.traits ? { traits: options.traits } : {}),
    ...(options.all ? { all: true } : {}),
    ...(options.read ? { read: true } : {}),
    ...(options.none ? { none: true } : {}),
    ...(options.prompt ? { prompt: options.prompt } : {}),
    ...(options.sessionName ? { sessionName: options.sessionName } : {}),
    ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}),
    ...(options.zai ? { zai: true } : {}),
    ...(options.ollama ? { ollama: true } : {}),
    ...(options.llamacpp ? { llamacpp: true } : {}),
    ...(options.ui ? { ui: options.ui } : {}),
    ...(options.noUi ? { noUi: true } : {}),
  };
}

export async function resumeCommand(sessionId: string | undefined, options: ResumeOptions): Promise<void> {
  if (sessionId) return resumeBySessionId(sessionId, options);
  const picked = await pickSessionToResume();
  if (!picked) throw new Error("No resumable Barry sessions found.");
  return resumeBySessionId(picked.id, options);
}

/**
 * Resume a specific Barry session by looking up its provider session ID
 * and passing it directly to the agent's resume flag.
 */
async function resumeBySessionId(sessionId: string, options: ResumeOptions): Promise<void> {
  const session = await getSession(sessionId);
  const scope = currentScope();
  if (scope.kind === "identity") assertOwnedSession(session, scope.binding.id);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  // Resume where the session actually ran. Agents scope their conversation
  // history per project directory, so resuming a session that ran in a
  // worktree from a different cwd finds no history to resume — the agent
  // silently opens its picker against the wrong project. Restoring the cwd
  // also puts the agent back among the files it was working on.
  const recordedCwd = parseMetadata(session.metadata).working_directory;
  if (recordedCwd && recordedCwd !== process.cwd()) {
    if (existsSync(recordedCwd)) {
      process.chdir(recordedCwd);
      console.log(`Working directory: ${recordedCwd}`);
    } else {
      // A deleted worktree is the common case. Resuming from the current
      // directory still recovers the conversation, so warn rather than abort.
      console.warn(
        `Recorded working directory no longer exists: ${recordedCwd}\n`
        + `Resuming from ${process.cwd()} — the agent may not find this session's history.`,
      );
    }
  }

  if (session.bound_id != null) throw new Error(`Session ${sessionId} still carries bound_id; run barry doctor --fix`);
  const recordedProvider = parseMetadata(session.metadata).provider;
  const records = await installedHarnesses();
  const provider = options.harness ?? (typeof recordedProvider === "string" ? recordedProvider : FALLBACK_HARNESS);
  const harness = findInstalled(records, provider)?.id ?? provider;
  const providerSessions = await getProviderSessionsBySession(sessionId);
  // Find the most recent provider session (they're ordered desc by created_at)
  const providerSession = providerSessions.find(
    (ps) => ((findInstalled(records, ps.provider)?.id ?? ps.provider) === harness) && ps.provider_session_id,
  );

  const startOpts: StartOptions = {
    barry: options.barry,
    _resumeSessionId: sessionId,
    _resumeTraits: session.traits ?? [],
    _resumeBounds: session.bounds ?? [],
    ...passthroughOptions(options),
    harness,
    ...resumedModelProvider(options, session.metadata),
  };

  if (!providerSession?.provider_session_id) {
    throw new Error(`No ${provider} conversation recorded for ${sessionId}; cannot resume this session without starting a different conversation.`);
  }

  startOpts._resume = { providerSessionId: providerSession.provider_session_id };
  return startCommand([], startOpts);
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
