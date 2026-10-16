// Method bodies extracted from session-runtime.ts for file size.
// Moved verbatim as free functions taking the runtime instance (`rt`);
// the SessionRuntime class delegates to these. Pure move + rewire.
import {SessionRuntime, log} from "../session-runtime.js";
import { assertInteractiveDestination } from "../workflow-session-ownership.js";
import type { ActiveSession, SessionTurnOutcome } from "../session-runtime.js";
import {buildSessionHistoryContext} from "../db.js";
import {type AuthPrincipal} from "@barry-rocks/sdk/internal/auth";
import {getAttachmentMetadata} from "@barry-rocks/sessions-bag/attachments";
import {authorizeSessionExecution} from "@barry-rocks/sessions-bag/execution-authorization";
import {copyFileSync, existsSync, mkdirSync} from "fs";
import {basename, join} from "path";

export async function rt_prepareTurnAttachments(rt: SessionRuntime, activeSession: ActiveSession, attachmentIds: string[]): Promise<string> {
    const sessionId = activeSession.id || activeSession.sessionId;
    if (!sessionId) throw new Error("Attachment input requires a session");
    // Validate the entire batch before copying any file. Missing files are an
    // admission error, not a successful turn with silently omitted input.
    for (const id of attachmentIds) {
      if (!/^att_[a-f0-9]{16}$/.test(id)) throw new Error("Invalid attachment reference");
      const meta = await getAttachmentMetadata(sessionId, id);
      if (!meta || meta.sessionId !== sessionId || meta.id !== id || !existsSync(meta.path)) {
        throw new Error("Attachment does not belong to this session or is unavailable");
      }
    }
    return attachmentIds.length ? rt_materializeAndFormatAttachments(rt, activeSession, attachmentIds) : "";
  }

export async function rt_materializeAndFormatAttachments(rt: SessionRuntime, 
    activeSession: ActiveSession,
    attachmentIds: string[],
  ): Promise<string> {
    const sid = activeSession.id || activeSession.sessionId;
    if (!sid) return "";
    const lines: string[] = ["<attachments>"];
    for (const id of attachmentIds) {
      const meta = await getAttachmentMetadata(sid, id);
      if (!meta) {
        lines.push(`Attachment ${id}: not found`);
        continue;
      }

      let materializedPath: string | null = null;
      if (activeSession.repoPath) {
        try {
          const targetDir = join(activeSession.repoPath, ".barry", "attachments", id);
          mkdirSync(targetDir, { recursive: true });
          const targetPath = join(targetDir, basename(meta.name).replace(/[^a-zA-Z0-9._-]/g, "_"));
          copyFileSync(meta.path, targetPath);
          materializedPath = targetPath;
        } catch (err) {
          log.warn("session.attachment_materialize_failed", {
            sessionId: activeSession.id,
            attachmentId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (materializedPath) {
        lines.push(`Attached file: ${meta.name} (${meta.mimeType}, ${meta.size} bytes)`);
        lines.push(`Path: ${materializedPath}`);
        lines.push("You can inspect this file using your filesystem tools.");
      } else {
        lines.push(`Attached file: ${meta.name} (${meta.mimeType}, ${meta.size} bytes)`);
        lines.push("[Notice: File cannot be materialized to filesystem under current session bounds. Attachment metadata available only.]");
      }
    }
    lines.push("</attachments>");
    return lines.join("\n");
  }

  /**
   * Send a follow-up message to an active session.
   * Uses the persistent session if available, otherwise falls back to creating a new one.
   */
export async function rt_sendMessage(rt: SessionRuntime, 
    sessionId: string,
    content: string,
    options: { ingressAt?: number; clientMessageId?: string; reuseClientMessageRow?: boolean; userMessageSequence?: number; initialHistoryContext?: string; attachmentIds?: string[] } = {},
    principal?: AuthPrincipal,
  ): Promise<void> {
    if (principal) await authorizeSessionExecution(principal, { sessionId });
    if (rt.executionGuard?.(sessionId)) throw new Error("Session has an active durable turn; queue later work explicitly");
    rt.assertPersistenceAdmission(sessionId);
    await rt.enqueueMessage(sessionId, content, options, false);
  }

  /** Deliver one correlated workflow turn and await the harness's terminal result event. */
export async function rt_sendMessageAndWait(rt: SessionRuntime, sessionId: string, content: string, workflowTurnId: string): Promise<SessionTurnOutcome> {
    if (!workflowTurnId || workflowTurnId.length > 500) throw new Error("workflow turn id is invalid");
    const outcome = await rt.enqueueMessage(sessionId, content, { workflowTurnId }, true);
    if (!outcome) throw new Error("workflow turn was not admitted");
    return outcome;
  }

export async function rt_enqueueMessage(rt: SessionRuntime, 
    sessionId: string,
    content: string,
    options: { ingressAt?: number; clientMessageId?: string; reuseClientMessageRow?: boolean; userMessageSequence?: number; initialHistoryContext?: string; attachmentIds?: string[]; workflowTurnId?: string },
    waitForTurn: boolean,
  ): Promise<SessionTurnOutcome | undefined> {
    assertInteractiveDestination(sessionId);
    rt.assertPersistenceAdmission(sessionId);
    const activeSession = rt.activeSessions.get(sessionId);
    if (!activeSession) {
      throw new Error(`Session ${sessionId} not found in active sessions`);
    }

    // Reset buffer and failure counter (user explicitly sending = intentional retry)
    activeSession.outputBuffer = "";
    activeSession.consecutiveFailures = 0;

    let effectiveContent = content;
    if (options.attachmentIds?.length) {
      const attachmentsPrefix = await rt_materializeAndFormatAttachments(rt, activeSession, options.attachmentIds);
      if (attachmentsPrefix) {
        effectiveContent = `${attachmentsPrefix}\n\n${content}`;
      }
    }

    // Snapshot history before publishing this turn's user row. A warm-opened
    // handle already owns its conversation even before init exposes its ID.
    let historyContext = options.initialHistoryContext ?? "";
    if (options.initialHistoryContext === undefined && !activeSession.sessionId && activeSession.lastSequence >= 0 && !activeSession.pendingTurns && !activeSession.abortController) {
      const durable=await rt.flushPersistence(sessionId);
      historyContext=await buildSessionHistoryContext(sessionId);
      if (!durable) {
        historyContext += "\n<recording-delayed>Uncommitted conversation events:\n" + rt.pendingPersistence(sessionId).map(frame=>JSON.stringify(frame)).join("\n") + "\n</recording-delayed>";
      }
    }
    if (activeSession.pendingTurns || activeSession.abortController) historyContext="";
    rt.broadcastToSession(sessionId, {
      type: "text",
      sessionId,
      content,
      role: "user",
      metadata: {
        source: "api_message",
        delivery: "accepted",
        ...(options.clientMessageId ? { clientMessageId: options.clientMessageId } : {}),
        ...(options.workflowTurnId ? { workflowTurnId: options.workflowTurnId } : {}),
        ...(options.attachmentIds?.length ? { attachmentIds: options.attachmentIds } : {}),
      },
      reuseClientMessageRow: options.reuseClientMessageRow,
      ...(options.userMessageSequence!==undefined ? {sequence:options.userMessageSequence} : {}),
    });

    if (!historyContext && (activeSession.session || activeSession.sessionId || activeSession.warming)) {
      // Resume the existing session — it has full conversation context
      log.info("sdk.send_to_session", { sessionId, sdkSessionId: activeSession.sessionId });
      const turn = rt.runSession(activeSession, effectiveContent, activeSession.mcpServers, options.ingressAt);
      if (waitForTurn) return turn;
      void turn;
    } else {
      // No session yet (cold start) — prepend history context
      log.info("sdk.send_cold_start", { sessionId });


      const promptParts = historyContext ? [
        historyContext,
        `<new-message>`,
        effectiveContent,
        `</new-message>`,
      ].filter(Boolean).join("\n") : effectiveContent;

      const turn = rt.runSession(activeSession, promptParts, activeSession.mcpServers, options.ingressAt);
      if (waitForTurn) return turn;
      void turn;
    }
  }
