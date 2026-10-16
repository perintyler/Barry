import {stopProcess} from "../sessions/stop-process.js";
/**
 * A hosted mode for any harness that speaks the Agent Client Protocol.
 *
 * ACP is an open standard, so the client lives here rather than in each
 * adapter: an adapter says how to start its harness in ACP mode and what the
 * mode guarantees, and gets a full hosted session. The harness runs as a stdio
 * child of whoever starts the session; after a restart, `adopt` continues the
 * conversation with `session/load`.
 */
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import type { Mode, SessionMode } from "../adapters/harnesses/index.js";
import type { Command } from "../adapters/harnesses/launch/index.js";
import type { Session, SessionConfig } from "../sessions/index.js";
import { openAcpSession, type AcpSessionOptions } from "./session.js";

export type { AcpToolCall, AcpToolIdentity } from "./session.js";

export interface AcpHarness extends Mode {
  structuredOutput: "native" | "prompted";
  /** How to start the harness speaking ACP on stdio. */
  command(config: SessionConfig): Command;
  /** An auth method id to use, when the harness advertises it. */
  authMethod?: string;
  /** How the harness's tool calls are named in Barry's policy. */
  identifyTool?: AcpSessionOptions["identifyTool"];
}

export function acpHosted(harness: AcpHarness): SessionMode {
  const open = (config: SessionConfig, resume?: string) =>
    startAcp(harness.command(config), config, harness, {
      ...(harness.authMethod ? { authMethod: harness.authMethod } : {}),
      ...(harness.identifyTool ? { identifyTool: harness.identifyTool } : {}),
      ...(resume ? { resume } : {}),
    });
  return {
    guarantees: harness.guarantees,
    verifiedOn: harness.verifiedOn,
    evidence: harness.evidence,
    egressSandbox: harness.egressSandbox,
    structuredOutput: harness.structuredOutput,
    ...(harness.platforms ? { platforms: harness.platforms } : {}),
    start: (config) => open(config),
    adopt: (harnessSessionId, config) => open(config, harnessSessionId),
  };
}

async function startAcp(
  launch: Command,
  config: SessionConfig,
  mode: Mode,
  extra: Pick<AcpSessionOptions, "authMethod" | "resume" | "identifyTool">,
): Promise<Session> {
  const env = Object.fromEntries(
    Object.entries(launch.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd ?? config.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Kept for the error message: when a harness dies during the handshake, its
  // own last words are the only explanation anyone gets.
  let stderrTail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000);
  });
  const spawned = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  await spawned;

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const release = () => stopProcess(child);

  try {
    return await openAcpSession({
      config,
      guarantees: mode.guarantees,
      connect: (app) => app.connect(stream),
      release,
      ...extra,
    });
  } catch (err) {
    await release();
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${launch.command} did not start an ACP session: ${reason}${stderrTail ? `\n${stderrTail.trim()}` : ""}`);
  }
}
