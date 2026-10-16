-- Durable producer occurrences and their dispatch outbox (P4.3 preparation).
--
-- Nothing writes these tables unless a scheduler is composed with an
-- occurrence ledger (work-producer-occurrences.ts). The legacy scheduler path
-- is unchanged; the tables exist so an occurrence and its dispatch intent can
-- commit in one transaction with the schedule_state due time they consume.

-- One logical occurrence: what was due, under which policy and authority
-- context, and the exact admission it will ever be submitted as. Immutable
-- once written — recovery after a lost reply must resubmit the ORIGINAL key,
-- payload and executor generation, never a recomputed one.
CREATE TABLE work_producer_occurrence (
  occurrence_id       TEXT PRIMARY KEY,
  -- Stable producer identity, e.g. schedules:<bag>/<name> or schedules:once:<bag>.
  producer_ref        TEXT NOT NULL,
  -- Exactly one of schedule_id / one_off_id names the source.
  schedule_id         TEXT,
  one_off_id          TEXT,
  -- What made it due: a calendar slot, a one-off `at`, a login event, a
  -- manual run, a one-off row, or the single re-run an overlap `queue` owes.
  kind                TEXT NOT NULL CHECK (kind IN ('slot', 'at', 'login', 'manual', 'one_off', 'queued')),
  -- The nominal calendar slot (UTC ISO) — never the dispatch time. Null for
  -- login/manual occurrences, which are identified by their event/manual id.
  slot_at             TEXT,
  -- The IANA zone the slot was computed in (schedules default to UTC).
  timezone            TEXT,
  -- The trigger spelling the slot was computed from (scheduler.ts triggerKey).
  trigger_key         TEXT,
  -- {catch_up, overlap, late, coalesced_slots, login_event_id?, manual_id?}.
  policy_json         TEXT NOT NULL,
  -- Schedule context as selected at the occurrence: identity/identity_id,
  -- traits, bounds. Recorded, never widened at dispatch.
  context_json        TEXT NOT NULL,
  -- {kind: action|job, reference, catalog_namespace?}.
  definition_json     TEXT NOT NULL,
  inputs_json         TEXT NOT NULL,
  -- The canonical admission key. Unique across producers: one key, one
  -- logical occurrence.
  idempotency_key     TEXT NOT NULL UNIQUE,
  -- Per-transport UUID kept for exact redelivery of the same submission.
  request_id          TEXT NOT NULL,
  -- Which executor generation owns this occurrence: 'legacy' (the existing
  -- scheduler runners) or 'work.v2' (canonical Work admission). Selected
  -- before the first dispatch and never switched afterwards.
  executor_generation TEXT NOT NULL CHECK (executor_generation IN ('legacy', 'work.v2')),
  created_at          TEXT NOT NULL,
  CHECK ((schedule_id IS NULL) <> (one_off_id IS NULL))
);
CREATE INDEX idx_work_producer_occurrence_schedule ON work_producer_occurrence(schedule_id, created_at);

CREATE TRIGGER work_producer_occurrence_immutable BEFORE UPDATE ON work_producer_occurrence
BEGIN
  SELECT RAISE(ABORT, 'producer occurrence identity is immutable');
END;

-- The dispatch outbox: how far delivery of each occurrence has got.
--
--   pending      recorded, never handed to an executor or owner
--   dispatching  a legacy launch or Work submission may have happened
--   accepted     the owner (or legacy runner) accepted it; terminal here
--   unknown      admission may have happened and could not be confirmed;
--                observe the original key, never start replacement work
--   refused      the owner refused this exact intent (authority/conflict)
--   skipped      overlap `skip` dropped it while the previous run was going
--   missed       catch_up `none` declined a late slot
--   coalesced    merged into an already-owed `queued` occurrence
CREATE TABLE work_producer_dispatch (
  occurrence_id     TEXT PRIMARY KEY REFERENCES work_producer_occurrence(occurrence_id),
  state             TEXT NOT NULL CHECK (state IN ('pending', 'dispatching', 'accepted', 'unknown', 'refused', 'skipped', 'missed', 'coalesced')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   TEXT NOT NULL,
  -- Bound by the first successful authority preparation; never replaced.
  authority_ref     TEXT,
  request_hash      TEXT,
  -- The owner's logical ids once accepted (or the legacy run/one-off id).
  work_id           TEXT,
  workflow_id       TEXT,
  last_error_code   TEXT,
  last_error        TEXT,
  -- How the occurrence ended for the schedule (complete/failed), for
  -- notification grouping. Null until known.
  outcome           TEXT,
  -- The process that moved it to `dispatching`, by identity (pid + start
  -- time), so a restarted scheduler can tell its own in-flight dispatch from
  -- a dead one's — and treat the dead one's as possibly admitted.
  dispatcher_pid        INTEGER,
  dispatcher_started_at INTEGER,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_work_producer_dispatch_due ON work_producer_dispatch(state, next_attempt_at);

-- Once bound, an authority reference, request hash or accepted work id is
-- the occurrence's identity at the owner: a later write may not change it.
CREATE TRIGGER work_producer_dispatch_bindings_immutable BEFORE UPDATE ON work_producer_dispatch
WHEN (OLD.authority_ref IS NOT NULL AND NEW.authority_ref IS NOT OLD.authority_ref)
  OR (OLD.request_hash IS NOT NULL AND NEW.request_hash IS NOT OLD.request_hash)
  OR (OLD.work_id IS NOT NULL AND NEW.work_id IS NOT OLD.work_id)
BEGIN
  SELECT RAISE(ABORT, 'accepted dispatch bindings are immutable');
END;

-- Accepted is terminal for the producer: after admission only the owner
-- decides retries, so nothing here may move it back to a dispatchable state.
CREATE TRIGGER work_producer_dispatch_accepted_terminal BEFORE UPDATE ON work_producer_dispatch
WHEN OLD.state = 'accepted' AND NEW.state <> 'accepted'
BEGIN
  SELECT RAISE(ABORT, 'accepted occurrences cannot be dispatched again');
END;

-- Possible admission is never downgraded to "not dispatched".
CREATE TRIGGER work_producer_dispatch_no_rewind BEFORE UPDATE ON work_producer_dispatch
WHEN OLD.state IN ('dispatching', 'unknown') AND NEW.state = 'pending'
BEGIN
  SELECT RAISE(ABORT, 'a possibly admitted occurrence cannot return to pending');
END;

-- Failure/recovery notifications, separate from the work that caused them.
-- One row per failure streak: repeated failures update the same row (grouped)
-- and delivery failure retries the notice, never the work.
CREATE TABLE work_producer_notification (
  notification_key  TEXT PRIMARY KEY,
  schedule_id       TEXT NOT NULL,
  transition        TEXT NOT NULL CHECK (transition IN ('failure', 'recovery')),
  -- The occurrence that opened the streak (failure) or closed it (recovery).
  occurrence_id     TEXT NOT NULL,
  failures          INTEGER NOT NULL DEFAULT 1,
  last_summary      TEXT,
  delivered_at      TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_work_producer_notification_pending ON work_producer_notification(delivered_at, schedule_id);
