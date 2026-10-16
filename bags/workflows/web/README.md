# Workflows Operator & Background Work Web Console

`bags/workflows/web` serves two operator web views from `createWorkflowServer`:

1. **`/work` (`work.html`, `work.js`, `work.css`, `waiting-reasons.js`)** — Task-first Background Work console (`/api/v2/work/**` and `/api/v2/recovery/**`).
2. **`/` (`index.html`, `app.js`, `style.css`, `state.js`, `routing.js`, `operations.js`, `waiting-reasons.js`)** — Low-level execution and event inspector (`/api/runs/**`, `/api/v2/runs`, `/api/overview`, `/api/audit`).

## Task-First State, Reason, and Cessation Model (`waiting-reasons.js`)

The Background Work surface separates five distinct dimensions so operators and identity callers never conflate them:

- **Logical outcome (`facts.coordinator`)**: `running`, `blocked`, `completed`, `failed`, `cancelled`, `timed_out`.
- **Physical cessation (`facts.physical`)**: `not-started`, `running`, `stopping`, `ceased`, `unknown`.
- **Effect certainty (`facts.effect`)**: `not-started`, `known`, `uncertain`.
- **Validation status (`validationState`)**: `passed`, `failed` (`Completed · checks failed` when postcondition or retained output validation fails), `not_run`.
- **Stop acknowledgement (`stopState`)**: `none`, `stopping` (`Stop requested` / `Stopping · awaiting cessation` while `facts.physical` is not yet `ceased`), `stopped` (`Cancelled` once `facts.physical === "ceased"`).

## Navigation Views

- **Needs attention (`#attention`)**: Work items in `needs-attention` or `waiting-for-approval`, or with uncertain effects / restore-paused recovery barriers.
- **Active (`#active`)**: Accepted, queued, running, waiting, and stopping work items.
- **Scheduled (`#scheduled`)**: Work items with `origin.trigger === "schedule"` or active timer waits (`facts.wait === "timer"`).
- **History (`#history`)**: Completed, failed, and cancelled work items.

## Schema-Driven Task Start and Recovery Guarantees

- **Schema-driven inputs (`deriveSchemaFields`, `buildAndValidateStartInputs`)**: Derives `<select>`, `<input type="checkbox">`, `<input type="number">`, `<textarea>`, and JSON inputs from the selected definition's `input_schema`, validating required fields, enums, numeric bounds, and JSON syntax before generating or locking an `idempotency_key`.
- **Refusal vs. unconfirmed ambiguity (`classifyAdmissionFailure`, `classifyStopFailure`)**:
  - Proven pre-admission/pre-stop refusals (`admission_disposition: "not-accepted" | "refused"`, `stop_disposition: "refused"`, `409 WorkRevisionConflict`) allow correcting inputs or refreshing the current revision without trapping the user in an unconfirmed retry banner.
  - Network drops, timeouts, and 5xx responses preserve the exact `idempotency_key` (or Stop `request_id` and `expected_revision`) across page reloads in `localStorage`.
