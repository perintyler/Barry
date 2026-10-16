-- Event producer preparation (P4.4): source-key deduplication, per-consumer
-- checkpoints and a dispatch outbox. Written only by the opt-in functions in
-- work-producer-events.ts; the existing event writer and its at-most-once
-- hook dispatch are unchanged.

-- A producer that can emit the same logical event twice (a crash between the
-- emit and its own watermark) names it. One source key, one event.
CREATE TABLE work_producer_event_source (
  source_key  TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- How far each consumer has recorded its work: the highest events.seq whose
-- outbox rows are committed. Advanced in the same transaction as those rows,
-- so a consumer restart neither skips nor re-records an event.
CREATE TABLE work_producer_event_checkpoint (
  consumer    TEXT PRIMARY KEY,
  last_seq    INTEGER NOT NULL,
  updated_at  TEXT NOT NULL
);

-- One logical occurrence of work an event (or a bounded run of coalesced
-- events) causes, and how far its delivery has got. States as in the
-- schedules outbox: pending, dispatching, accepted, unknown, refused.
CREATE TABLE work_producer_event_outbox (
  occurrence_id        TEXT PRIMARY KEY,
  consumer             TEXT NOT NULL,
  -- The event that opened this occurrence.
  event_id             TEXT NOT NULL,
  event_seq            INTEGER NOT NULL,
  -- Events folded into this occurrence while it was still pending (bounded).
  coalesce_key         TEXT,
  coalesced_event_ids  TEXT NOT NULL DEFAULT '[]',
  coalesced_count      INTEGER NOT NULL DEFAULT 1,
  definition_json      TEXT NOT NULL,
  inputs_json          TEXT NOT NULL,
  idempotency_key      TEXT NOT NULL UNIQUE,
  request_id           TEXT NOT NULL,
  executor_generation  TEXT NOT NULL CHECK (executor_generation IN ('legacy', 'work.v2')),
  state                TEXT NOT NULL CHECK (state IN ('pending', 'dispatching', 'accepted', 'unknown', 'refused')),
  attempts             INTEGER NOT NULL DEFAULT 0,
  next_attempt_at      TEXT NOT NULL,
  authority_ref        TEXT,
  request_hash         TEXT,
  work_id              TEXT,
  workflow_id          TEXT,
  last_error_code      TEXT,
  last_error           TEXT,
  dispatcher_pid        INTEGER,
  dispatcher_started_at INTEGER,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX idx_work_producer_event_outbox_due ON work_producer_event_outbox(state, next_attempt_at);
CREATE INDEX idx_work_producer_event_outbox_coalesce ON work_producer_event_outbox(consumer, coalesce_key, state) WHERE coalesce_key IS NOT NULL;

-- What the occurrence will be submitted as never changes after insert.
CREATE TRIGGER work_producer_event_outbox_identity BEFORE UPDATE ON work_producer_event_outbox
WHEN NEW.occurrence_id IS NOT OLD.occurrence_id OR NEW.consumer IS NOT OLD.consumer OR NEW.event_id IS NOT OLD.event_id
  OR NEW.definition_json IS NOT OLD.definition_json OR NEW.inputs_json IS NOT OLD.inputs_json
  OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.request_id IS NOT OLD.request_id
  OR NEW.executor_generation IS NOT OLD.executor_generation OR NEW.coalesce_key IS NOT OLD.coalesce_key
BEGIN
  SELECT RAISE(ABORT, 'event occurrence identity is immutable');
END;

-- Coalescing only folds events into an occurrence nobody has dispatched yet.
CREATE TRIGGER work_producer_event_outbox_coalesce_pending BEFORE UPDATE ON work_producer_event_outbox
WHEN NEW.coalesced_count IS NOT OLD.coalesced_count AND OLD.state <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'only a pending occurrence can absorb more events');
END;

CREATE TRIGGER work_producer_event_outbox_bindings BEFORE UPDATE ON work_producer_event_outbox
WHEN (OLD.authority_ref IS NOT NULL AND NEW.authority_ref IS NOT OLD.authority_ref)
  OR (OLD.request_hash IS NOT NULL AND NEW.request_hash IS NOT OLD.request_hash)
  OR (OLD.work_id IS NOT NULL AND NEW.work_id IS NOT OLD.work_id)
BEGIN
  SELECT RAISE(ABORT, 'accepted dispatch bindings are immutable');
END;

CREATE TRIGGER work_producer_event_outbox_accepted BEFORE UPDATE ON work_producer_event_outbox
WHEN OLD.state = 'accepted' AND NEW.state <> 'accepted'
BEGIN
  SELECT RAISE(ABORT, 'accepted occurrences cannot be dispatched again');
END;

CREATE TRIGGER work_producer_event_outbox_no_rewind BEFORE UPDATE ON work_producer_event_outbox
WHEN OLD.state IN ('dispatching', 'unknown') AND NEW.state = 'pending'
BEGIN
  SELECT RAISE(ABORT, 'a possibly admitted occurrence cannot return to pending');
END;
