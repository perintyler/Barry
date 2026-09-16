-- Drop actors.models — a denormalized copy of the model catalog that was
-- written by seed.ts and read by nothing.
--
-- It shipped in 001_baseline.sql alongside actors.provider, encoding the idea
-- that an agent actor carries its own provider + model list. That never got
-- wired up: `messages` has no actor FK, so there is no join path from a
-- message to an actor's models, and no code ever selected the column. It sat
-- holding a snapshot of whatever MODEL_CATALOG said at first seed (still
-- listing gpt-5.1-codex-max, retired since).
--
-- Per-message model provenance is being modelled properly via providers/models
-- tables and messages.model_id; this column is not part of that design and
-- would be a second, stale source of truth for the same fact.
--
-- actors.provider is deliberately KEPT: it is real, non-derived data about the
-- agent (which vendor it is), unlike the model list which changes weekly.

ALTER TABLE actors DROP COLUMN IF EXISTS models;
