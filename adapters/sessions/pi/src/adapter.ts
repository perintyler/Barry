/**
 * Pi, as Barry's adapter contract sees it.
 *
 * Hosted runs the Pi SDK (`@earendil-works/pi-coding-agent`) in-process —
 * the live pattern on Pi's own package — with Barry as the only client of the
 * session.
 *
 * Instrumented and guest modes are refused (`null`): a Pi TUI authenticates
 * with the user's own `~/.pi/agent/auth.json` login, which is outside the
 * identity's declared sources. Hosted resolves keys from the identity's
 * environment alone.
 */
import { defineAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import type { SessionConfig } from "@barry-rocks/sdk/sessions";
import { PI_CAPABILITIES } from "./capabilities.js";
import { PI_HOSTED, PI_REQUIREMENTS } from "./modes.js";
import { NATIVE_TOOLS, NATIVE } from "./native-tools.js";
import { PI_OFFERED_MODELS, listPiModels } from "./offered-models.js";
import { piTranscript } from "./transcript.js";
import {
  type ExecutionAccessV1,
  type InferencePolicyV1,
  type ProviderLimitCapabilitiesV1,
  fingerprintInferencePolicy,
} from "./inference-bounds.js";
import type { InferenceFaultV1 } from "./inference-fault.js";
import type { UsageReconcilePortV1 } from "./inference-reconciliation.js";
import type { UsageSinkV1 } from "./inference-usage.js";

export * from "./inference-bounds.js";
export * from "./inference-usage.js";
export * from "./inference-fault.js";
export * from "./inference-reconciliation.js";

export interface PiInferenceRuntimeOptions {
  readonly inferencePolicy?: InferencePolicyV1;
  readonly providerCapabilities?: ProviderLimitCapabilitiesV1;
  readonly usageSink?: UsageSinkV1;
  readonly usageReconcilePort?: UsageReconcilePortV1;
  readonly executionAccess?: ExecutionAccessV1;
  readonly modelCallId?: string;
  readonly allowAuthorizedCostEstimate?: boolean;
  readonly onFault?: (fault: InferenceFaultV1) => void | Promise<void>;
  readonly customFetch?: typeof globalThis.fetch;
}

const RELEASE_IDLE_SERVER_MS = 10 * 60_000;

export type PiAdapterStartConfig = SessionConfig & PiInferenceRuntimeOptions;

function extractInferenceOptions(
  config: PiAdapterStartConfig,
): PiInferenceRuntimeOptions {
  return {
    inferencePolicy: config.inferencePolicy,
    providerCapabilities: config.providerCapabilities,
    executionAccess: config.executionAccess,
    usageSink: config.usageSink,
    usageReconcilePort: config.usageReconcilePort,
    onFault: config.onFault,
    allowAuthorizedCostEstimate: config.allowAuthorizedCostEstimate,
    modelCallId: config.modelCallId,
    customFetch: config.customFetch,
  };
}

export default defineAdapter({
  bag: ".",
  id: "pi",
  label: "Pi",
  requirements: PI_REQUIREMENTS,
  capabilities: PI_CAPABILITIES,
  tools: NATIVE_TOOLS,
  defaultMode: "hosted",
  offeredModels: PI_OFFERED_MODELS,
  listModels: listPiModels,
  modes: {
    hosted: {
      ...PI_HOSTED,
      native: NATIVE,
      structuredOutput: "prompted",
      approvalContinuation: "durable",
      openContinuation: async (config) => {
        const [{ createPiAgentSession }, { PiContinuation }, { executionHash }] = await Promise.all([
          import("./hosted/sdk-session.js"), import("./hosted/continuation.js"), import("@barry-rocks/sdk/sessions"),
        ]);
        const inferenceOptions = extractInferenceOptions(config as PiAdapterStartConfig);
        const session = await createPiAgentSession(config, {
          durable: true,
          ...inferenceOptions,
        });
        const fingerprint = executionHash({
          sessionId: config.sessionId, cwd: config.cwd, model: config.model ?? null,
          ...(config.endpoint ? { endpoint: { baseUrl: config.endpoint.baseUrl } } : {}),
          ...(inferenceOptions.inferencePolicy
            ? { inferencePolicy: fingerprintInferencePolicy(inferenceOptions.inferencePolicy) }
            : {}),
          systemPrompt: config.systemPrompt ?? null, deniedTools: config.deniedTools ?? [],
          pluginDirs: config.pluginDirs ?? [], projectRoots: config.projectRoots ?? [],
          // Secret values are neither checkpointed nor used as immutable identity.
          mcpServers: Object.entries(config.mcpServers).map(([name, server]) => ({ name, type: server.type ?? "stdio", address: "url" in server ? server.url : server.command, args: "args" in server ? server.args ?? [] : [] })),
        });
        return PiContinuation.fromSession(
          session,
          fingerprint,
          config.sessionId,
          inferenceOptions,
        );
      },
      start: async (config) => {
        const { startPiHosted } = await import("./hosted/sdk-session.js");
        const inferenceOptions = extractInferenceOptions(config as PiAdapterStartConfig);
        return startPiHosted(config, {
          guarantees: PI_HOSTED.guarantees,
          releaseAfterMs: RELEASE_IDLE_SERVER_MS,
          ...inferenceOptions,
        });
      },
      adopt: (harnessSessionId, config) => {
        if (!harnessSessionId) {
          throw new Error("adopt requires the conversation id to resume; none was given");
        }
        const inferenceOptions = extractInferenceOptions(config as PiAdapterStartConfig);
        return import("./hosted/sdk-session.js").then(({ startPiHosted }) =>
          startPiHosted(
            { ...config, resume: { harnessSessionId } },
            {
              guarantees: PI_HOSTED.guarantees,
              releaseAfterMs: RELEASE_IDLE_SERVER_MS,
              ...inferenceOptions,
            },
          ),
        );
      },
    },
    instrumented: null,
    guest: null,
  },
  transcript: piTranscript,
});
