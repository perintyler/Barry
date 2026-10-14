# File changes tracker

Changes remain append-only during normal use. Each serialized diff is capped at 64 KiB. Larger payloads retain a bounded preview, original serialized byte count and SHA-256; the row keeps the session, file, tool and reported file size. Truncation is explicit in the changes API. This is a retention record, not a replacement for file contents or Git history.

The daily `tracker/retention` job and owner-only `filesystem.prune` tool delete only changes older than 90 days whose session is confirmed terminal, unpinned, and ended at least 90 days ago. Missing, live, pinned, unreadable and recently closed sessions are retained. Closure evidence comes from the authenticated sessions API, without opening another bag's store. A cursor bounds each pass to 100 sessions and avoids starving later eligible records. Each session loses at most 1,000 qualifying rows per pass. Recent changes remain append-only; the DELETE exception exists only inside a write transaction that restores the guard before committing. Failed transactions restore both data and guard.

New databases use incremental auto-vacuum; pruning frees pages and incrementally returns some space to disk. Legacy databases reuse freed pages. Converting an existing database to auto-vacuum requires an explicit SQLite VACUUM, which may need substantial temporary disk space; the daily job does not rewrite a large legacy database.

History beyond the retention window may disappear from session changes views. The unused `working_directory` and `edit_index` fields were DTO placeholders rather than database columns; removing them requires no SQL column migration.

Use Node 26.9 or later and the repository’s frozen pnpm workspace installation. This package is linked within the repository; this documentation does not claim a published SDK or package release.

See the [operating documentation](../../../README.md) for installation and verification.
