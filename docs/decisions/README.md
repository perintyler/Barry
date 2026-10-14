# Architecture Decision Records

Each ADR records one decision: the context, the choice, and its consequences.
They are referenced from the code and tests they govern (search the tree for
`docs/decisions/`), so an ADR and its `## Note NNN` anchors are a stable contract,
not a scratchpad. Add a new record as the next number; supersede an old one with a
new ADR rather than rewriting history.

| ADR | Title |
|---|---|
| 0001 | [Shared log format](0001-shared-log-format.md) |
| 0002 | [Test store isolation](0002-test-store-isolation.md) |
| 0003 | [Telemetry collector invariants](0003-telemetry-collector-invariants.md) |
| 0004 | [Telemetry extension and alert invariants](0004-telemetry-extension-and-alert-invariants.md) |
| 0005 | [Telemetry storage and metric invariants](0005-telemetry-storage-and-metric-invariants.md) |
| 0006 | [Telemetry usage and rendering invariants](0006-telemetry-usage-and-rendering-invariants.md) |
| 0007 | [Telemetry schedule cadence](0007-telemetry-schedule-cadence.md) |
| 0008 | [Telemetry regression contracts](0008-telemetry-regression-contracts.md) |
| 0009 | [Runtime and fixture invariants](0009-runtime-and-fixture-invariants.md) |
| 0010 | [Adapter and session regression invariants](0010-adapter-and-session-regression-invariants.md) |
| 0011 | [SDK runtime invariants](0011-sdk-runtime-invariants.md) |
| 0012 | [explicit credentials, cross-store action evidence, and trait ownership](0012-credentials-action-runs-and-traits.md) |
| 0013 | [session-store boundaries and MCP admission evidence](0013-session-store-and-mcp-admission.md) |
| 0014 | [discovery, vault access, and session budget invariants](0014-discovery-vault-and-session-budgets.md) |
| 0015 | [verification and socket invariants](0015-verification-and-socket-invariants.md) |
| 0016 | [vault daemon boundaries](0016-vault-daemon-boundaries.md) |
| 0017 | [SDK discovery and wire contracts](0017-sdk-discovery-and-wire-contracts.md) |
| 0018 | [MCP transport and action metadata invariants](0018-mcp-transport-and-action-metadata.md) |
| 0019 | [CLI checkouts and session selection](0019-cli-checkouts-and-session-selection.md) |
| 0020 | [session route catalog and cache invariants](0020-session-route-catalog-and-cache-invariants.md) |
| 0021 | [telemetry polling and adapter regressions](0021-telemetry-polling-and-adapter-regressions.md) |
| 0022 | [SDK authentication and logging invariants](0022-sdk-auth-and-logging-invariants.md) |
| 0023 | [harness version compatibility](0023-harness-version-compatibility.md) |
| 0024 | [Claude trust for explicitly created directories](0024-claude-created-directory-trust.md) |
| 0025 | [private generated vendor configurations](0025-private-vendor-configurations.md) |
| 0026 | [Codex stdio MCP environment indirection](0026-codex-stdio-environment.md) |
| 0027 | [Regression evidence boundaries](0027-regression-evidence-boundaries.md) |
| 0028 | [Codex custom endpoint configuration](0028-codex-custom-endpoint-configuration.md) |
| 0029 | [Codex hook failure denial](0029-codex-hook-failure-denial.md) |
| 0030 | [Cursor hook schema](0030-cursor-hook-schema.md) |
| 0031 | [bag ownership and vault failure distinctions](0031-bag-ownership-and-vault-regressions.md) |
| 0032 | [SDK contract regression history](0032-sdk-contract-regression-history.md) |
| 0033 | [tracked capture and transport rationale](0033-tracked-capture-and-transport-rationale.md) |
| 0034 | [adapter builds, capture and relay rationale](0034-adapter-build-capture-and-relay-rationale.md) |
| 0035 | [Session route ownership and summary scheduling](0035-session-route-and-summary-rationale.md) |
| 0036 | [CLI launch and persistence rationale](0036-cli-launch-and-persistence-rationale.md) |
| 0037 | [Service routes and qualified tool identity](0037-service-route-and-tool-identity-rationale.md) |
| 0038 | [Test isolation and command reservations](0038-test-isolation-and-command-reservations.md) |
| 0039 | [Structured diagnostics across library boundaries](0039-structured-library-diagnostics.md) |
| 0040 | [Integrating repository gates with the comment pass](0040-repository-gate-integration.md) |
| 0041 | [Command classification and completion](0041-command-classification-and-completion.md) |
| 0042 | [Vault key custody and action records](0042-vault-key-custody-and-action-records.md) |
| 0043 | [telemetry classification, alerts and full tick cost](0043-telemetry-classification-and-alert-cost.md) |
| 0044 | [trait validation diagnostics and mounted server labels](0044-trait-validation-diagnostics.md) |
| 0045 | [auto-trait eligibility and packed bag names](0045-auto-trait-eligibility.md) |
| 0046 | [instance, service and event comment audit](0046-instance-service-and-event-comments.md) |
