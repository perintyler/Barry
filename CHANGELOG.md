# Changelog

Changes are recorded here after landing. This section describes unreleased source changes; it does not announce published packages or a release-mirror sync.

## Unreleased

- Land the installation foundation and document its independent continuation. [PR #57](https://github.com/perintyler/barry-dev/pull/57)
- Protect session attachments and recorded transcript backfills with validated ids, ownership checks and canonical containment. [PR #67](https://github.com/perintyler/barry-dev/pull/67)
- Route terminal session closure through the lifecycle funnel and enforce consistent persisted terminal fields. Explicit reopening remains supported. [PR #81](https://github.com/perintyler/barry-dev/pull/81)
- Fix ordinary shell-classifier gaps under the documented best-effort guard threat model. [PR #68](https://github.com/perintyler/barry-dev/pull/68)
- Recover session storage divergence and use a unified SQLite connection wrapper to protect live WAL/SHM state. [PR #110](https://github.com/perintyler/barry-dev/pull/110)
- Consolidate SDK specification and workflow documentation paths. [PR #111](https://github.com/perintyler/barry-dev/pull/111)
- Vendor the repository checks so local verification does not fetch a private checks repository. Private GitHub Actions remain disabled. [PR #62](https://github.com/perintyler/barry-dev/pull/62)
- Add security reporting, dependency updates, formatting, spelling, contributor documentation, pinned public-mirror workflows and a complete local static gate. [PR #71](https://github.com/perintyler/barry-dev/pull/71)

SDK-specific history remains in [sdk/CHANGELOG.md](sdk/CHANGELOG.md). The remaining review program and original findings are tracked in [plans/review-resolution/README.md](plans/review-resolution/README.md).
