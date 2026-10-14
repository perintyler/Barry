// Method bodies extracted from session-runtime.ts for file size.
// Moved verbatim as free functions taking the runtime instance (`rt`);
// the SessionRuntime class delegates to these. Pure move + rewire.
import { SessionRuntime, log, typedMessagesApart } from "../session-runtime.js";
import type { ActiveSession, RendererAttachment } from "../session-runtime.js";
import { updateSessionRecord } from "../db.js";
import { turnEventsOf } from "../turn-events.js";
import { type AuthPrincipal } from "@barry-rocks/sdk/internal/auth";
import { type Session } from "@barry-rocks/sdk/sessions";
import { authorizeSessionExecution } from "@barry-rocks/sessions-bag/execution-authorization";
import { readProcessStartTime } from "@barry-rocks/sessions-bag/process-liveness";
import { randomUUID } from "node:crypto";

  /**
   * Open the session's hosted harness to a TUI that `launcherPid` launches:
   * the engine it connects to and the conversation it resumes. The session is
   * kept — never evicted, its engine never idled out — while any attachment
   * holds it, and an attachment lasts until it detaches or its launcher dies.
   */
export async function rt_attachRenderer(rt: SessionRuntime, sessionId: string, launcherPid: number, principal?: AuthPrincipal): Promise<RendererAttachment> {
    if (principal) await authorizeSessionExecution(principal, { sessionId });
    const activeSession = rt.activeSessions.get(sessionId);
    if (!activeSession) throw new Error(`Session ${sessionId} not found in active sessions`);
    const startedAt = readProcessStartTime(launcherPid);
    if (startedAt === null) throw new Error(`The launching process ${launcherPid} is not running`);

    const attachmentId = randomUUID();
    // Held before anything awaits, so the session cannot be evicted while it opens.
    activeSession.renderers.set(attachmentId, { pid: launcherPid, startedAt });
    let session: Session | null = null;
    try {
      session = await rt.ensureHarnessSession(activeSession);
      if (!session.attach) throw new Error(`${activeSession.provider} has no TUI that can attach to its hosted session`);
      const attachment = await session.attach();
      activeSession.sessionId ??= attachment.harnessSessionId;
      void rt.recordExternalTurns(activeSession, session);
      rt.checkLaunchers();
      log.info("session.renderer_attached", { sessionId, attachmentId, launcherPid });
      return { attachmentId, ...attachment };
    } catch (err) {
      activeSession.renderers.delete(attachmentId);
      throw err;
    }
  }

  /** End one attachment. False when it was already gone. */
export async function rt_detachRenderer(rt: SessionRuntime, sessionId: string, attachmentId: string, principal?: AuthPrincipal): Promise<boolean> {
    if (principal) await authorizeSessionExecution(principal, { sessionId });
    const activeSession = rt.activeSessions.get(sessionId);
    if (!activeSession?.renderers.has(attachmentId)) return false;
    rt.releaseRenderer(activeSession, attachmentId);
    return true;
  }

export function rt_releaseRenderer(rt: SessionRuntime, activeSession: ActiveSession, attachmentId: string): void {
    activeSession.renderers.delete(attachmentId);
    activeSession.session?.detach?.();
    log.info("session.renderer_detached", { sessionId: activeSession.id, attachmentId });
    if (activeSession.renderers.size > 0) return;
    if (activeSession.toolsChangedWhileAttached) {
      activeSession.toolsChangedWhileAttached = false;
      rt.invalidateSessionTools(activeSession.id);
    }
    // The launcher recorded the session as running; with its TUI gone and no
    // turn under way, it rests as a finished turn leaves it.
    if (!activeSession.abortController && activeSession.pendingTurns === 0) {
      void updateSessionRecord(activeSession.id, { status: "pending" }).catch((e) => {
        log.warn("session.rest_status_failed", { sessionId: activeSession.id, error: e instanceof Error ? e.message : String(e) });
      });
    }
  }

  /**
   * Frees attachments whose launcher died without detaching, so a killed
   * `barry start` cannot keep a session's engine forever. Runs while any
   * attachment exists.
   */
export function rt_checkLaunchers(rt: SessionRuntime): void {
    if (rt.launcherCheck) return;
    rt.launcherCheck = setInterval(() => {
      let held = 0;
      for (const activeSession of rt.activeSessions.values()) {
        for (const [attachmentId, launcher] of activeSession.renderers) {
          if (rt.launcherRunning(launcher)) held++;
          else {
            log.info("session.renderer_launcher_gone", { sessionId: activeSession.id, attachmentId, launcherPid: launcher.pid });
            rt.releaseRenderer(activeSession, attachmentId);
          }
        }
      }
      if (held === 0 && rt.launcherCheck) {
        clearInterval(rt.launcherCheck);
        rt.launcherCheck = null;
      }
    }, rt.launcherCheckMs);
    rt.launcherCheck.unref?.();
  }

  /**
   * Records turns another client started, such as a person typing in an
   * attached TUI, as Barry's own turns are. Ends when the session closes.
   */
export async function rt_recordExternalTurns(rt: SessionRuntime, activeSession: ActiveSession, session: Session): Promise<void> {
    if (!session.externalTurns || rt.recordingExternalTurns.has(session)) return;
    rt.recordingExternalTurns.add(session);
    const typed = (content: string) => rt.broadcastToSession(activeSession.id, {
      type: "text",
      sessionId: activeSession.id,
      content,
      role: "user",
      metadata: { source: "terminal", delivery: "accepted" },
    });
    let warned = session.warnings?.length ?? 0;
    try {
      for await (const event of turnEventsOf(typedMessagesApart(session.externalTurns(), typed))) {
        await rt.handleRunnerEvent(activeSession, event);
        // A session can learn something worth a warning mid-life, such as its
        // tool gate switched off from the TUI and turned back on.
        for (const warning of session.warnings?.slice(warned) ?? []) {
          log.warn("sdk.session_warning", { sessionId: activeSession.id, provider: activeSession.provider, warning });
        }
        warned = session.warnings?.length ?? 0;
      }
    } catch (err) {
      log.error("session.external_turns_failed", { sessionId: activeSession.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
