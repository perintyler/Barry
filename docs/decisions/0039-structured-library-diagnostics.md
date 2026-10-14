# ADR 0039: Structured diagnostics across library boundaries

## Context

The original review found raw library console calls that bypass LOG_LEVEL and structured telemetry. The first SDK pass left warning/error calls because the existing ESLint rule explicitly allowed those methods. A fresh AST inventory found 39 remaining calls in 21 files, including event hooks, identity files, scheduling, captures, history projection, search, telemetry and vault startup.

## Decision

Use the shared logger with an explicit stderr transport, stable service/event names and original reason text. Preserve exception messages and stacks where the original console call supplied an Error object. Keep stdout and return/exit/lifecycle behavior intact. The session-tracker usage line remains exact command-interface text on stderr. Engine info/debug events now use their actual levels and existing context fields.

Reject raw library console calls, including warnings/errors. CLI interfaces and the Workers logger retain their explicit transport exceptions; the two originally permitted launchd entry modules remain exceptions. An override must supply an empty options object because overriding severity alone retains the earlier warn/error allowance.

## Consequences

LOG_LEVEL=silent can suppress library diagnostics without suppressing data results. Named diagnostics remain attributable and the shared redaction runs before emission. Module imports instantiate stderr loggers but do not open stores or authenticate. Warning/error fixture assertions observe the logger boundary while delegating to the real writer; independent real-process tests verify JSON stderr, silence and unchanged event-hook return behavior. Final complete gates and packed/bundled verification remain required.

## Preserved engine logger explanation

The session bag already depends on the SDK. The original comment's dependency claim was false; its complete context is retained here.

```ts
/**
 * This bag logs through `console`, like its bookkeeping and reaper paths —
 * taking a logger dependency here would pull a package the sessions bag does
 * not otherwise need, and the engine path is low-volume.
 */
const log = {
  info: (event: string, fields: Record<string, unknown>) =>
    console.warn(`[engines] ${event}`, JSON.stringify(fields)),
  debug: (event: string, fields: Record<string, unknown>) =>
    console.warn(`[engines] ${event}`, JSON.stringify(fields)),
};
```

## Verification checkpoint

Two real-process tests failed before conversion because output was unstructured and LOG_LEVEL=silent was ignored. Both pass after conversion. An AST inventory finds zero remaining console calls in the reviewed library scope after excluding executable interface scripts, generated sources, the Workers transport and the two original launchd exceptions. Controls exercise actual ESLint configuration: library warn/error calls refuse, while CLI and Workers interfaces retain their exceptions. Failed options/fixture checks are retained in local logs. Broad current-head types, full unit tests and the final local gate remain necessary before finding closure.

The complete original-call/replacement inventory is `/private/tmp/barry-step21-library-diagnostics-conversion.json`; current AST inventory is `/private/tmp/barry-step21-library-console-audit.json`; controls are `/private/tmp/barry-step21-console-policy-control.json`.
