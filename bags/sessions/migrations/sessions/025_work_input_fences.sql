-- Independent, immutable exclusion proof for a Work-owned destination. It must
-- be writable before the destination's session/turn exists, hence no FK.
CREATE TABLE session_workflow_work_input_fences (
  key TEXT PRIMARY KEY,
  binding_key TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  declaration_hash TEXT NOT NULL CHECK(length(declaration_hash)=64),
  never_started INTEGER NOT NULL CHECK(never_started IN (0,1)),
  proof_hash TEXT NOT NULL CHECK(length(proof_hash)=64),
  proof_json TEXT NOT NULL CHECK(json_valid(proof_json))
);
CREATE TRIGGER session_workflow_work_input_fences_immutable_update BEFORE UPDATE ON session_workflow_work_input_fences
BEGIN SELECT RAISE(ABORT,'work input fence is immutable'); END;

-- A successor may be accepted before any native claim. Under the same writer
-- exclusion as the cancellation tombstone, this records positive never-claimed
-- evidence for that exact segment. It never replaces an existing settlement.
CREATE TABLE session_workflow_work_segment_exclusions (
  segment_id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  binding_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  declaration_hash TEXT NOT NULL CHECK(length(declaration_hash)=64),
  intent_hash TEXT NOT NULL CHECK(length(intent_hash)=64),
  proof_hash TEXT NOT NULL CHECK(length(proof_hash)=64),
  proof_json TEXT NOT NULL CHECK(json_valid(proof_json))
);
CREATE TRIGGER session_workflow_work_segment_exclusions_immutable_update BEFORE UPDATE ON session_workflow_work_segment_exclusions
BEGIN SELECT RAISE(ABORT,'work segment exclusion is immutable'); END;
CREATE TRIGGER session_workflow_work_segment_exclusions_immutable_delete BEFORE DELETE ON session_workflow_work_segment_exclusions
BEGIN SELECT RAISE(ABORT,'work segment exclusion is immutable'); END;
CREATE TRIGGER session_workflow_work_input_fences_immutable_delete BEFORE DELETE ON session_workflow_work_input_fences
BEGIN SELECT RAISE(ABORT,'work input fence is immutable'); END;
