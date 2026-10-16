import { apiRequest, apiFailure } from "./api-request.js";
/**
 * The data-returning steps of `barry start`'s launch-context resolution.
 *
 * `resolveLaunchContext` in commands/start.ts used to inline all of this as one
 * ~500-line function with nested closures and a large transport branch, which
 * meant the only way to exercise any of its logic was to spawn a real child
 * session. These four steps return DATA (native tool selection, an MCP config
 * written to disk, the session pre-create request body, the child env) rather
 * than performing their side effects inline, so each can be called directly in
 * a unit test:
 *
 *   - `resolveSessionNativeTools` — native-tool selection from resolved bound + tools (pure)
 *   - `buildMcpConfig`            — materialize an McpConfig to a temp dir (fs only)
 *   - `preCreateSession`          — POST a session row, built from a pure request body
 *   - `buildLaunchEnv`            — the child env scaffold (pure) + provenance keys
 *
 * `resolveLaunchContext` composes them, so the behavior the golden launch tests
 * pin is unchanged: this is a refactor, not a behavior change.
 */
import { writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { McpConfig } from "../config.js";
import type { Bound, Tool } from "@barry-rocks/sdk";
import type { ModeId } from "@barry-rocks/sdk/ids";
import { resolveNativeTools, type NativeToolResolution, type NativeHarness } from "@barry-rocks/sdk/bounds";

/** The native-tool decision for a session, derived from its resolved bound and tools. */
export interface SessionNativeToolResolution {
  native: NativeToolResolution;
  /** Native inventory withheld by the session's bound or mode. */
  deniedTools: string[];
  /** Native tools the session's bound allows and the mode can control. */
  allowedNativeTools: string[];
}

/**
 * The native-tool selection a session runs under, from its already-resolved
 * bound and tools. Pure: no store, no network, no console — `resolveNativeTools`
 * is a pure function of bound + tools + harness + mode, and this names its two
 * derived lists so a caller (and a test) does not have to reach into the
 * resolution to get them.
 */
export function resolveSessionNativeTools(
  session: { bound: Bound | null; tools?: readonly Tool[] },
  harnessRecord: NativeHarness,
  mode: ModeId,
): SessionNativeToolResolution {
  const native = resolveNativeTools(session.bound, session.tools ?? [], harnessRecord, mode);
  return { native, deniedTools: native.denied, allowedNativeTools: native.allowed };
}

/** Where a materialized MCP config was written, and the servers it holds. */
export interface McpConfigArtifact {
  /** The temp dir the config file lives in; the caller tracks it for cleanup. */
  tmpDir: string;
  /** Path to the written `mcp.json`. */
  mcpConfigPath: string;
  /** The servers the config holds, for a harness that takes them directly. */
  mcpServers: McpConfig["mcpServers"];
}

/**
 * Write an already-resolved `McpConfig` to a fresh temp dir and hand back the
 * path, the servers, and the dir to track for cleanup.
 *
 * `tmpRoot` defaults to the OS temp dir, matching the inline code; a test can
 * point it at its own scratch dir.
 */
export function buildMcpConfig(config: McpConfig, tmpRoot: string = tmpdir()): McpConfigArtifact {
  const tmpDir = mkdtempSync(join(tmpRoot, "barry-mcp-"));
  const mcpConfigPath = join(tmpDir, "mcp.json");
  writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2));
  return { tmpDir, mcpConfigPath, mcpServers: config.mcpServers };
}

/** The inputs a `/sessions/start` pre-create row is built from. */
export interface PreCreateSessionInput {
  sessionId: string;
  cwd: string;
  /** Which surface started it: cursor/codex/opencode, else "cli". */
  source: string;
  identityId: number | null;
  selectedBounds: string[];
  harness?: string;
  provider?: string;
  directive?: string | null;
  name?: string;
  bags?: string[];
  model?: string;
  modelProvider?: string;
  mode?: ModeId;
  status?: "pending" | "running";
}

/**
 * The JSON body a session pre-create POSTs. Pure, so the exact shape the row is
 * created with can be asserted without a running API — the field names here are
 * a contract with the sessions API (`sessionId`, `bags`, `bounds`, `provider`, …),
 * and a rename on either side silently drops data.
 */
export function preCreateRequestBody(input: PreCreateSessionInput): Record<string, unknown> {
  return {
    sessionId: input.sessionId,
    cwd: input.cwd,
    source: input.source,
    directive: input.directive,
    name: input.name,
    identityId: input.identityId,
    bounds: input.selectedBounds,
    provider: input.harness ?? input.provider ?? "",
    ...(input.bags !== undefined ? { bags: input.bags } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.modelProvider ? { model_provider: input.modelProvider } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.status ? { status: input.status } : {}),
  };
}

/** How a pre-create attempt ended. */
export interface PreCreateResult {
  ok: boolean;
  /** The body that was (or would have been) sent. */
  body: Record<string, unknown>;
  /** Present when the POST failed; the warning the caller prints. */
  warning?: string;
}

/**
 * Dependencies `preCreateSession` reaches for the network through. Injected so
 * a unit test drives the two outcomes (accepted / rejected) without a live
 * sessions API — the production caller passes the real `fetch` and endpoint.
 */
export interface PreCreateSessionDeps {
  fetch: typeof fetch;
  endpoint: string;
  timeoutMs?: number;
  headers: Record<string, string>;
}

/**
 * POST a session pre-create row and report how it went, from the pure request
 * body above. Returns data (`{ ok, body, warning }`) rather than printing or
 * throwing: the caller decides whether a rejected pre-create is fatal (it is
 * only when `--bound` was requested), so this must not make that call itself.
 *
 * Mirrors the inline closure's error handling: a non-2xx response and a thrown
 * fetch both come back as `ok: false` with a warning, never an exception.
 */
export async function preCreateSession(
  input: PreCreateSessionInput,
  deps: PreCreateSessionDeps,
): Promise<PreCreateResult> {
  const body = preCreateRequestBody(input);
  try {
    const resp = await apiRequest(deps.fetch, deps.endpoint, {
      method: "POST",
      headers: deps.headers,
      body: JSON.stringify(body),
    }, deps.timeoutMs ?? 5000);
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      return { ok: false, body, warning: `session pre-create failed (HTTP ${resp.status}) — ${detail.slice(0, 200)}` };
    }
    return { ok: true, body };
  } catch (err) {
    return { ok: false, body, warning: apiFailure(deps.endpoint, err, deps.timeoutMs ?? 5000) };
  }
}

/** The inputs the child env scaffold is built from. */
export interface LaunchEnvInput {
  /** The base environment to clone (normally `process.env`). */
  baseEnv: Record<string, string | undefined>;
  /** The hook-binary dir prepended to PATH. */
  cliBin: string;
  sessionId: string;
  directive: string | null;
  identityId: number | null;
  /** Credential env vars stripped so no ambient key reaches the harness. */
  stripCredentialNames: Iterable<string>;
}

/**
 * The child env BEFORE credentials and provenance are applied: the shell's
 * environment, with the hook bin on PATH, the session id (and directive/id)
 * set, and every declared credential name stripped so no ambient key is
 * inherited. Pure — a clone, never a mutation of `baseEnv`.
 *
 * The required-credential values and the provenance keys (`BARRY_PROVIDER`,
 * `BARRY_MODEL`, …) are applied by the caller AFTER this, because they depend
 * on model resolution and the credential gate that run against this scaffold
 * first. `launchProvenanceEnv` names those provenance keys for the caller to
 * assign at that point.
 */
export function buildLaunchEnv(input: LaunchEnvInput): Record<string, string | undefined> {
  const childEnv: Record<string, string | undefined> = { ...input.baseEnv };
  childEnv.PATH = `${input.cliBin}:${childEnv.PATH ?? ""}`;
  childEnv.BARRY_SESSION_ID = input.sessionId;
  if (input.directive) childEnv.BARRY_DIRECTIVE = input.directive;
  if (input.identityId) childEnv.BARRY_ID = String(input.identityId);
  for (const name of new Set(input.stripCredentialNames)) delete childEnv[name];
  return childEnv;
}

/** The resolved harness/model/mode a session records. */
export interface LaunchProvenanceInput {
  harness?: string;
  provider?: string;
  model?: string;
  modelProvider?: string;
  mode: string;
}

/**
 * The provenance env keys handed to the session-tracker hook, which has no
 * other way to learn the resolved harness/model/mode (its payload carries no
 * such field). Only the keys with a value are set — matching the inline code,
 * which sets `BARRY_MODEL`/`BARRY_MODEL_PROVIDER` conditionally but always sets
 * `BARRY_PROVIDER` and `BARRY_MODE`.
 */
export function launchProvenanceEnv(input: LaunchProvenanceInput): Record<string, string> {
  const env: Record<string, string> = {
    BARRY_PROVIDER: input.harness ?? input.provider ?? "",
    BARRY_MODE: input.mode,
  };
  if (input.model) env.BARRY_MODEL = input.model;
  if (input.modelProvider) env.BARRY_MODEL_PROVIDER = input.modelProvider;
  return env;
}
