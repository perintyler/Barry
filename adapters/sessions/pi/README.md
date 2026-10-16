# @barry-rocks/session-pi

Install this adapter independently:

```sh
npm install @barry-rocks/session-pi
```

The default export is the Barry session adapter declaration. Importing it reads capabilities and native-tool policy; starting a session is explicit. The package ships compiled ESM, declarations and its native-tool bag manifest for Node 26.

```ts
import adapter from "@barry-rocks/session-pi";

console.log(adapter.id, adapter.defaultMode);
```

Barry owns identity credentials, traits and bounds. Installing the adapter does not grant access or borrow a shell credential. Provider executables and accounts are separate requirements; inspect the declaration's requirements and modes before starting a session.

Select the installed package explicitly with `barry adapter add ./node_modules/@barry-rocks/session-pi`. Barry does not register sibling session packages automatically. Listing model choices requires the caller's selected environment; providers must not use an ambient account credential.

The package declares `barry.sessionAdapter.contractVersion: 1` and exports compiled ESM. After upgrading it, reselect its package directory with `barry adapter add`. Use `barry adapter remove <adapter-id>` to remove its selection while preserving package files and registered bag data.

## Connection, environment and modes

Hosted mode runs the pinned Pi SDK in process and connects to the selected model provider. It is the only available mode; instrumented and guest launches are refused. Bind the provider's credential variable in the Barry identity. The credential resolver reads that declared environment, rather than Pi's `auth.json` or `models.json`. Barry preserves Pi's normal session and agent directories and does not redirect `PI_CODING_AGENT_DIR`. The adapter does not declare an egress sandbox. See `src/modes.ts` and `src/credentials.ts` for the supported guarantees and required keys.

## Inference policy, usage accounting, and endpoint controls

`@barry-rocks/session-pi` exports typed inference-accounting and endpoint-control primitives (`InferencePolicyV1`, `ProviderLimitCapabilitiesV1`, `UsageEvidenceV1`, `UsageSinkV1`, `UsageReconcilePortV1`, `InferenceFaultV1`, `ExecutionAccessV1`) and accepts optional `PiInferenceRuntimeOptions` when starting a hosted session or opening a durable continuation:

- **Execution vs. inference placement independence**: Execution access (`ExecutionAccessV1`, carrying `WorkExecutionDelegation`, `WorkOwnerConnection`, and an `AbortSignal`) is verified independently of the configured inference endpoint (`anthropic-messages`, `openai-completions`, or `ollama-chat`). Local, sandbox, container, or remote execution environments can target any compatible local or remote inference endpoint.
- **Pre-send policy and budget enforcement**:
  - `max_output_tokens` is projected onto the wire request (`max_tokens` for Anthropic Messages and OpenAI-compatible completions, `max_completion_tokens` when advertised by `ProviderLimitCapabilitiesV1`, or `options.num_predict` for Ollama) and clamped before dispatch.
  - Strict `max_input_tokens` and `max_cost` policies are evaluated before network dispatch; if the provider lacks a supported pre-send tokenizer (`supported_tokenizers` + `tokenizer_id`) or retained `PriceScheduleV1` covering all active token categories (including reasoning and cache read/write bounds), the adapter fails closed with a structured `policy_refused` fault (`InferencePolicyViolationError`) before sending any bytes.
  - `deadline` and `max_calls` are enforced before dispatch and bound to the request `AbortSignal`.
  - Automatic SDK retries are disabled (`maxRetries: 0`, `maxRetryDelayMs: 1`) under Work policy, preventing silent duplicate provider charges.
- **Truthful usage and cost accounting**:
  - `ProviderStreamUsageTracker` inspects raw SSE/stream frames (`onProviderStreamEvent`) before SDK normalization so omitted or partial provider usage is never fabricated as `0`.
  - Every model call emits `UsageEvidenceV1` (`schema: 1`) with explicit `status` (`"known"` | `"partial"` | `"unknown"`), `observation_kind` (`"delta"` | `"snapshot"` | `"final"`), `reported_cost`, `calculated_cost`, `price_version`, `final`, and `unknown_reason`.
  - Legacy `usage` session events are emitted only when input and output token counts are finite measured integers; missing or partial usage is reported exclusively through `UsageSinkV1` and `UsageReconcilePortV1`.
  - `UsageAccountingCoordinator` deduplicates `delta`, `snapshot`, and `final` evidence across replay, restart, and lost acknowledgements by `(work_id, attempt_id, execution_fence, model_call_id)` and rejects contradictory `final` records.
- **Sanitized fault and rate-limit classification**:
  - Provider and transport errors are classified into `InferenceFaultV1` (`policy_refused`, `auth_rejected`, `forbidden`, `rate_limited`, `provider_overloaded`, `provider_5xx`, `model_unavailable`, `context_length_exceeded`, `invalid_request`, `transport_unreachable`, `timeout`, `aborted`, `malformed_response`, `stream_truncated`, `reconciliation_conflict`, `provider_error`) with explicit `request_phase` (`pre_send`, `before_headers`, `after_headers`, `midstream`, `post_usage_before_ack`), `admission_certainty` (`not_sent`, `possibly_sent`, `acknowledged`), and parsed `Retry-After` observations (`retry-after-ms`, `retry-after-seconds`, or `retry-after-http-date`).
  - Raw provider error strings, prompts, and credentials (`Bearer`, `sk-ant-...`, `sk-...`, `x-api-key`) are redacted before surfacing in `InferenceFaultV1` or session error events.

Hosted cancellation follows the [shared Session contract](../../../sdk/src/sessions/README.md):
interrupt acknowledges a request; the runtime owns the completion deadline. Close aborts startup,
releases owned resources, and ends an open reader once. Shared conformance tests exercise this adapter.

