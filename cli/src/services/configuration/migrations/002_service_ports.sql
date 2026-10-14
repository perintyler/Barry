
-- Where each service listens, assigned once and kept.
--
-- Ports used to be a formula (a base plus an environment offset), so nothing
-- noticed another program already on a port until the service crash-looped on
-- EADDRINUSE. The supervisor now assigns a free port the first time it starts a
-- service, and this table is what makes that assignment stable across restarts
-- and upgrades: bookmarks, the phone's pinned endpoints and hosting routes all
-- point at a number, and a number that moved silently breaks all of them.
--
-- Keyed by the service's registry name (`lists.web`), which is what every
-- client looks up. `port` is UNIQUE so two services can never be handed the
-- same one, even by two writers racing.

CREATE TABLE service_ports (
  service     TEXT    PRIMARY KEY,
  port        INTEGER NOT NULL UNIQUE CHECK (port BETWEEN 1024 AND 65535),
  assigned_at TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
