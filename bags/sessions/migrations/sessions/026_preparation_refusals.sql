-- Positive same-owner evidence that an exclusively acquired preparation never
-- invoked native ownership. This receipt and its settlement commit together.
CREATE TABLE session_workflow_preparation_refusals (
  segment_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  binding_key TEXT NOT NULL,
  declaration_hash TEXT NOT NULL CHECK(length(declaration_hash)=64),
  intent_hash TEXT NOT NULL CHECK(length(intent_hash)=64),
  owner_process_hash TEXT NOT NULL CHECK(length(owner_process_hash)=64),
  proof_kind TEXT NOT NULL CHECK(proof_kind='native-preparation-not-invoked@1'),
  refused_at TEXT NOT NULL
);
CREATE TRIGGER session_workflow_preparation_refusals_immutable_update BEFORE UPDATE ON session_workflow_preparation_refusals
BEGIN SELECT RAISE(ABORT,'preparation refusal is immutable'); END;
CREATE TRIGGER session_workflow_preparation_refusals_immutable_delete BEFORE DELETE ON session_workflow_preparation_refusals
BEGIN SELECT RAISE(ABORT,'preparation refusal is immutable'); END;
