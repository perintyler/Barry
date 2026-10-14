
-- config.db keeps what core owns: the bag registry and the port assignments.
--
-- traits and bounds belong to the identities bag and live in identities.db
-- now (its migration 002). An existing installation's rows are copied there by
-- the cutover's data move, which compares counts before this file is opened
-- at its new path, so dropping them here loses nothing.
--
-- settings and repos have had no code since their routes were deleted
-- (2a1115ca3, 2026-09-29): nothing reads or writes them.
--
-- A new migration rather than an edit to the baseline: a baseline cannot
-- change once a database has run it.

DROP TABLE traits;
DROP TABLE bounds;
DROP TABLE settings;
DROP TABLE repos;
