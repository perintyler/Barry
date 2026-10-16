# Linking two machines

Use an owner Mac and a second Mac with working installations. Linux worker production support is still an [owner decision](support.md#platforms); disposable Linux verification does not establish systemd installation support. This walkthrough describes the protocol exercised by [verify-nodes.ts](../cli/scripts/verify-nodes.ts); a real two-machine/tunnel onboarding run remains required acceptance evidence.

Complete [installation](install.md) on each machine first, including adding its installed command directory to `PATH`. Keep each machine's own `BARRY_HOME` set if you used a custom instance. A `--no-start` development installation must have its services started before following this walkthrough.

On the owner, install and configure a tunnel-provider bag that supports private HTTPS routes. Add a route to `workflows.runtime` in the instance's `hosting.yaml` (`barry config` prints its path). For example, this is the policy shape; replace `my-tunnel-provider` and `my-instance` with your installed provider bag and its configured instance, and choose a port that provider supports:

```yaml
tunnels:
  worker:
    via: my-tunnel-provider
    instance: my-instance
    reach: private
    gate: none
    routes:
      "8451": workflows.runtime
```

The worker endpoint must be callable without an interactive sign-in gate. A public route also exposes the operator console and its sign-in page. See the [hosting config schema](../sdk/src/services/hosting/config.ts) and the [tested private-route example](../cli/src/commands/workers-url.test.ts) for the configuration shape; provider installation and credentials follow that provider's instructions.

On the owner:

```sh
barry up
barry hosting status workflows.runtime
barry workers invite second-mac --jobs sessions:summarize-session@1
barry workers list --json
```

`barry up` applies the hosting configuration. Before inviting the worker, check that hosting status shows the intended private HTTPS address and applied target with no interactive gate. Doctor does not establish tunnel reachability before enrollment.

The invite prints a `barry workers join` command once. Transfer that exact command privately and run it on the worker, then:

```sh
barry service restart workflows.runtime
barry workers list --json
barry workers status
barry doctor --json
```

On the enrolled worker, doctor sends an authenticated read-only probe to the recorded owner and checks its installation id. A failed `node:owner:...` check identifies a credential, address or reachability problem without replacing the running worker's session. The owner cannot probe an invited pull worker because enrollment records no callable worker endpoint; its doctor report states that limitation.

The owner's list contains the assigned worker id and allowed jobs; the worker's list contains the owner's HTTPS address and the worker identity. The owner never gains an outgoing connection merely by inviting a worker. An invite without `--jobs` or `--expires-in` emits a version 1 token compatible with workers on master and has no expiry. Scoped invites default to a 24-hour unused-invite expiry. Add `--expires-in 86400` to an unscoped invite to request the same expiry; expiry or scope requires a version 2 worker. Keep every token private and revoke unused nonexpiring invites.

The jobs advertised by the worker depend on available binaries, labels, artifacts and the owner-assigned job scope. `barry workers status` explains unmet requirements. To add a real local-model capability, set `BARRY_WORKFLOW_LABELS` under `services.workflows.runtime.env` in the worker's `barry.yaml` to include `model=local`, then restart `workflows.runtime` and rerun status. Only claim labels the machine can satisfy. Before the label is set, a job requiring it is not advertised; afterwards it can be advertised if its remaining requirements and scope also pass. Labels do not install model software.

To remove access, on the owner run:

```sh
barry workers revoke second-mac
barry workers list --json
```

Revocation refuses the worker's next authenticated call and aborts its current activity. On the worker, `barry workers leave <owner>` removes the outgoing enrollment; use the owner name/id shown by its list. Retain the owner audit observations when diagnosing an unexpected session takeover.

Verified by the [node verifier](../cli/scripts/verify-nodes.md), peer trust tests and workflow placement tests. This proves the loopback protocol and refusal rules. It cannot prove your tunnel provider, physical machines or model inference; retain those checks separately. See [distributed trust](../sdk/docs/distributed-trust.md) and the [support playbook](support.md#when-something-is-wrong).
