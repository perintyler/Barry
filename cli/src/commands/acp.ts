/**
 * `barry acp`: serve Barry as an ACP agent on stdin/stdout, for an editor to
 * run as its agent (Zed, JetBrains, Toad).
 *
 * The protocol side lives in the sessions bag (`serveAcp`); this is the half
 * that reaches Barry — the API, for sessions and their messages, and the
 * active identity, for who the client is. Stdout is the protocol channel, so
 * nothing here writes to it; anything worth saying goes to stderr.
 */
import { basename } from "node:path";
import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { AgUiConnection, type AgUiEvent, type RunAgentInput } from "@barry-rocks/sdk/apps";
import { EventType } from "@ag-ui/core";
import type { BarryMessage, BarrySessions } from "@barry-rocks/sessions-bag/renderer/acp-server";
import { getServicePort } from "@barry-rocks/sdk/services";
import { identityRecords } from "@barry-rocks/identities-bag";
import { getActiveIdentity, getCurrentUser } from "../lib/current-user.js";

function apiHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(process.env.BARRY_SECRET ? { Authorization: `Bearer ${process.env.BARRY_SECRET}` } : {}),
  };
}

/** Barry's sessions, through its API. */
export class ApiSessions implements BarrySessions {
  private readonly client: AgUiConnection;
  private readonly turns = new Map<string, {
    onMessage(message: BarryMessage): void;
    finish(): void;
    fail(error: unknown): void;
    pending: string[];
    decisions: Map<string, { allow: boolean; reason?: string }>;
    calls: Map<string, { tool: string; input: unknown }>;
    seenCursors: Set<string>;
    resuming: boolean;
    cancelled: boolean;
    controller: AbortController;
  }>();
  private readonly base: string;

  constructor(options: { apiPort: number }) {
    this.base = `http://localhost:${options.apiPort}/api/v1`;
    this.client = new AgUiConnection({ baseUrl: `http://localhost:${options.apiPort}/api/v2/sessions`, secret: process.env.BARRY_SECRET });
  }

  async identity(): Promise<string | undefined> {
    const row = await this.identityRow();
    return row === undefined ? undefined : String(row);
  }

  async ownerOf(sessionId: string): Promise<string | undefined> {
    const response = await fetch(`${this.base}/sessions/${sessionId}`, { headers: apiHeaders() });
    if (!response.ok) return undefined;
    const session = (await response.json()) as { identityId?: number | null };
    return typeof session.identityId === "number" ? String(session.identityId) : undefined;
  }

  async create(cwd: string): Promise<string> {
    const identityId = await this.identityRow();
    const response = await fetch(`${this.base}/sessions`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({
        // The session's label where Barry lists sessions; no harness reads it.
        systemPrompt: `ACP session in ${basename(cwd) || cwd}`,
        repoPath: cwd,
        reviewPolicy: { mode: "review_required" },
        ...(identityId !== undefined ? { identityId } : {}),
      }),
    });
    if (!response.ok) throw new Error(`creating a session failed: ${await problemOf(response)}`);
    return ((await response.json()) as { id: string }).id;
  }

  async prompt(sessionId: string, text: string, onMessage: (message: BarryMessage) => void): Promise<void> {
    const snapshot = await this.client.snapshot(sessionId);
    if (snapshot.turn && ["running", "waiting_for_input", "recovery_required"].includes(snapshot.turn.state)) {
      throw new Error(`session already has a ${snapshot.turn.state} turn`);
    }
    const messageId = randomUUID();
    const runId = randomUUID();
    const input = {
      threadId: sessionId, runId, protocolVersion: "1.0", messages: [...snapshot.messages, { id: messageId, role: "user", content: text }], tools: [], context: [],
    } as RunAgentInput;
    let resolve!: () => void; let reject!: (error: unknown) => void;
    const ended = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const turn = { onMessage, finish: resolve, fail: reject, pending: [], decisions: new Map(), calls: new Map(), seenCursors: new Set<string>(), resuming: false, cancelled: false, controller: new AbortController() };
    this.turns.set(sessionId, turn);
    try { await this.runSegment(sessionId, turn, input); await ended; }
    catch (error) { this.turns.delete(sessionId); throw error; }
  }

  async interrupt(sessionId: string): Promise<void> {
    const snapshot = await this.client.snapshot(sessionId);
    if (snapshot.turn) await this.client.cancel(sessionId, snapshot.turn.id);
    const turn = this.turns.get(sessionId);
    if (turn) {
      turn.cancelled = true; turn.controller.abort();
      this.turns.delete(sessionId); turn.finish();
    }
  }

  async history(sessionId: string): Promise<BarryMessage[]> {
    const snapshot = await this.client.snapshot(sessionId);
    const messages: BarryMessage[] = [];
    for (const message of snapshot.messages) {
      if (message.role === "user" || message.role === "assistant") {
        if (typeof message.content === "string" && message.content) messages.push({ type: "text", role: message.role, content: message.content });
        for (const call of message.role === "assistant" ? message.toolCalls ?? [] : []) {
          let input: unknown = call.function.arguments;
          try { input = JSON.parse(call.function.arguments); } catch { /* retain original provider arguments */ }
          messages.push({ type: "tool_start", toolUseId: call.id, name: call.function.name, input });
        }
      } else if (message.role === "tool") {
        messages.push({ type: "tool_result", toolUseId: message.toolCallId, result: message.content });
      }
    }
    return messages;
  }

  async ruling(sessionId: string, requestId: string, decision: "allow" | "deny", reason?: string): Promise<void> {
    const turn = this.turns.get(sessionId);
    if (!turn || !turn.pending.includes(requestId)) throw new Error("approval is no longer pending");
    if (turn.decisions.has(requestId)) throw new Error("approval was already submitted");
    turn.decisions.set(requestId, { allow: decision === "allow", ...(reason ? { reason } : {}) });
    if (turn.decisions.size !== turn.pending.length || turn.resuming) return;
    turn.resuming = true;
    try {
      const snapshot = await this.client.snapshot(sessionId);
      if (!snapshot.turn || snapshot.turn.state !== "waiting_for_input") throw new Error("turn is no longer waiting for approval");
      const runId = randomUUID();
      const input = {
        threadId: sessionId, runId, protocolVersion: "1.0", messages: snapshot.messages, tools: [], context: [],
        resume: turn.pending.map((interruptId) => ({ interruptId, status: "resolved", payload: { approved: turn.decisions.get(interruptId)!.allow, ...(turn.decisions.get(interruptId)!.reason ? { reason: turn.decisions.get(interruptId)!.reason } : {}) } })),
      } as RunAgentInput;
      turn.pending = []; turn.decisions.clear();
      await this.runSegment(sessionId, turn, input);
    } catch (error) { turn.fail(error); this.turns.delete(sessionId); throw error; }
    finally { turn.resuming = false; }
  }

  close(): void {
    for (const turn of this.turns.values()) { turn.cancelled = true; turn.controller.abort(); turn.fail(new Error("ACP connection closed")); }
    this.turns.clear();
    this.client.close();
  }

  /** The active identity's row id: what a session records as its owner. */
  private async identityRow(): Promise<number | undefined> {
    const user = await getCurrentUser();
    const name = getActiveIdentity(user);
    if (!name) return undefined;
    const found = await identityRecords.find(name).catch(() => undefined);
    if (!found) return undefined;
    return (await identityRecords.rowId(found.record, { actorId: user.id })) ?? undefined;
  }

  private async runSegment(sessionId: string, turn: NonNullable<ReturnType<typeof this.turns.get>>, input: RunAgentInput): Promise<void> {
    let terminal = false;
    let failure: unknown;
    for (let attempt = 0; attempt < 3 && !terminal; attempt++) {
      try {
        for await (const delivery of this.client.run(input, { signal: turn.controller.signal })) {
          if (turn.seenCursors.has(delivery.cursor)) continue;
          turn.seenCursors.add(delivery.cursor);
          const event: AgUiEvent = delivery.event;
          if (event.type === EventType.TEXT_MESSAGE_CHUNK) turn.onMessage({ type: "text", role: "assistant", content: event.delta });
          else if (event.type === EventType.TOOL_CALL_START) turn.calls.set(event.toolCallId, { tool: event.toolCallName ?? "tool", input: "" });
          else if (event.type === EventType.TOOL_CALL_ARGS) {
            const call = turn.calls.get(event.toolCallId); if (call) call.input = `${typeof call.input === "string" ? call.input : ""}${event.delta}`;
          } else if (event.type === EventType.TOOL_CALL_END) {
            const call = turn.calls.get(event.toolCallId);
            if (call) {
              try { call.input = JSON.parse(String(call.input)); } catch { /* keep raw args for ACP display */ }
              turn.onMessage({ type: "tool_start", toolUseId: event.toolCallId, name: call.tool, input: call.input });
            }
          } else if (event.type === EventType.TOOL_CALL_RESULT) {
            turn.onMessage({ type: "tool_result", toolUseId: event.toolCallId, result: event.content });
          } else if (event.type === EventType.RUN_FINISHED) {
            const outcome = event.outcome as { type?: string; interrupts?: Array<{ id: string; toolCallId?: string }> } | undefined;
            if (outcome?.type === "interrupt") {
              const snapshot = await this.client.snapshot(sessionId);
              const pending = snapshot.turn?.interrupts.filter((item) => item.status === "pending") ?? [];
              turn.pending = pending.map((item) => item.id);
              turn.decisions.clear();
              for (const item of pending) {
                turn.calls.set(item.call.id, { tool: item.call.tool, input: item.call.input });
                turn.onMessage({ type: "permission_request", requestId: item.id, toolUseId: item.call.id, tool: item.call.tool, input: item.call.input });
              }
            } else {
              terminal = true; this.turns.delete(sessionId); turn.finish();
            }
          } else if (event.type === EventType.RUN_ERROR) {
            turn.onMessage({ type: "error", error: event.message ?? "AG-UI run failed" });
            terminal = true; this.turns.delete(sessionId); turn.finish();
          }
        }
        if (terminal || turn.pending.length) return;
        throw new Error("AG-UI run stream ended without a terminal outcome or interrupt");
      } catch (error) {
        if (turn.cancelled) return;
        failure = error;
        // Replaying the same request ID is safe. Event cursors suppress frames
        // already delivered before the transport failed.
      }
    }
    if (failure) throw failure instanceof Error ? failure : new Error(String(failure));
  }
}

async function problemOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { detail?: string; error?: string };
  return body.detail ?? body.error ?? `HTTP ${response.status}`;
}

export async function acpCommand(): Promise<void> {
  const { serveAcp } = await import("@barry-rocks/sessions-bag/renderer/acp-server");
  const sessions = new ApiSessions({ apiPort: getServicePort("api") });
  const connection = serveAcp(sessions, {
    input: Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    output: Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  });
  await new Promise<void>((resolve) => connection.signal.addEventListener("abort", () => resolve(), { once: true }));
  sessions.close();
}
