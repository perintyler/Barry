# ADR 0023: harness version compatibility

Status: accepted; replaces the previous version-family refusal rule

## Context

A tested build is useful installation guidance and reproducible evidence. It does not establish that every other build is incompatible. Refusing Codex after any pre-1.0 minor update, or Cursor after a calendar month change, turned an untested update into an outage without evidence of a failure.

## Decision

Each mode may declare a `versions` policy:

- `recommendedVersion`: advisory installation guidance.
- `testedVersions`: exact runtime builds with evidence for that mode's guarantees.
- `supportedVersions`: explicit ranges; `min` and `max` are inclusive, `before` is exclusive. Multiple ranges form a union.
- `incompatibleVersions`: ranges with a specific reason for refusal. Exclusions take precedence over supported ranges and test history.

Semantic versions and calendar versions are compared explicitly. Calendar dates order releases; a vendor build suffix is retained for exact test evidence, not interpreted as a semantic prerelease. No compatibility boundary is inferred from a major, minor, or month number.

Supported builds start normally. Builds outside established support warn and run. Unreadable versions are reported as unknown and unverified. Only documented incompatible versions are refused by the version policy. Credential checks, mandatory tool restrictions, platform limitations, and ordinary executable/protocol failures remain independent requirements. The former `BARRY_HARNESS_VERSION_CHECK=off` does not bypass a documented incompatibility.

Executable resolution honors an adapter's explicit executable environment override, otherwise its declared current paths and session PATH. An invalid explicit override is an error, not permission to select another executable. Shipped adapters do not prefer historic version directories. Update suppression keeps an executable stable during a session; it is not an installation pin.

Bundled modes describe the SDK/runtime they actually run, independently of a PATH CLI used by interactive modes or model discovery. Exact package dependencies remain reproducible build inputs.

Startup, doctor, setup, and local schedule forecasts share the same version assessment. Session metadata retains the observed executable/build and assessment. Supported compatibility does not establish that every build in a range passed the guarantee checks. Updating a recommendation does not discard previously tested builds.

## Migration and evidence

Older `binary.pin` registrations are normalized to `binary.recommendedVersion`. Older `verifiedOn` declarations establish only that exact tested build, not a major-wide support range. Setup refreshes shipped registrations at the same package path; explicit package selections elsewhere retain ownership. Re-register other updated packages through adapter registration when their declarations change. Persist bundled-mode metadata in new records; older records that omitted it require re-registration rather than guessing which runtime they use.

Initially preserve existing evidence conservatively. Broaden a mode's range or update its recommendation only after relevant checks. Local protocol/fake-provider checks, real-provider authentication checks, and interactive UI checks are distinct evidence; passing one does not establish the others. Known OpenCode v1 CLI incompatibility remains an explicit exclusion because the adapter drives the v2 server/standalone interface.

## Consequences

Vendor updates no longer fail solely because their version differs from Barry's recommendation. Untested builds remain visible in diagnostics and session records. An exact known-good installation can still be selected explicitly for recovery or reproducible deployment.
