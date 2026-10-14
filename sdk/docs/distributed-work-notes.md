# distributed work design notes

A workflow combines recoverable computation, tasks, external events, and time. The engine advances a state machine; application code decides its next commands. Queues provide flow control and decouple execution from availability. Durable timers cover both waiting and failure detection.

The central invariant is atomicity across workflow state, task creation, and timers. Independent successful writes are insufficient: a crash between them can strand work or expose work before its state exists. When delivery crosses a storage boundary, commit a local transfer record with the state, then deliver asynchronously and deduplicate retries.

Temporal bounds individual workflows and scales their number. Its sharding, routing, matching, and visibility components solve requirements introduced by cluster scale. Visibility can lag authoritative state. Reliable maintenance can itself use workflows.

## Application to our sketch — design judgments

Use one SQLite transaction boundary per owner. Pending activity rows are the durable delivery queue; no separate broker is necessary. Preserve the sketch's fixed ownership and explicit downtime behavior. Cluster membership, shard reassignment, replicated consensus, and automatic failover would solve a different problem.

Keep workflow interpretation local and worker placement outside replay. Persist intent before dispatch, and fence each response by its physical attempt. Stable idempotency keys identify logical effects across retries; they cannot make external systems transactional.
