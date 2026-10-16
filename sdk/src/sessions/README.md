# Hosted session cancellation contract

`Session.interrupt()` idempotently requests cancellation of the current turn. Its acknowledgement does
not prove that the event reader has ended. A late acknowledgement must never interrupt the next turn.
An ordinary interrupted turn emits exactly one `done` and leaves the conversation reusable.

`Session.close()` aborts startup and retries, closes owned resources, and settles an open reader with
exactly one `done`. Closing an idle session emits no phantom event. Late provider completions cannot
produce another terminal event or affect a new generation. Processes started by the adapter must be
terminated with bounded graceful cleanup and SIGKILL escalation; shared MCP services are never targets.

The sessions runtime owns the event-reader deadline and execution lease. After an explicit interrupt,
it waits up to `BARRY_INTERRUPT_DEADLINE_MS` (10 seconds by default) for turn completion, including time
spent in an unresponsive `interrupt()` call. A hard stop cancels immediately. Generation fences prevent
late output and a late harness open from reviving stopped work. There is no automatic total-turn timeout.

`describeSessionContract` from `@barry-rocks/sdk/testing` runs the same normal, interrupt/reuse,
close/resource-release, and repeated/late-completion scenarios against each adapter's controllable fake.
Deadline helpers do not cancel work themselves; ownership and abort belong to the caller. `envMs`
accepts finite positive milliseconds up to 2,147,483,647; all other values use the declared fallback.
