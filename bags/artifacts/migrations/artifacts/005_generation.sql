CREATE TABLE artifact_generation_status (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  state TEXT NOT NULL CHECK (state IN ('active','sealed')),
  sealed_at TEXT,
  CHECK ((state = 'active' AND sealed_at IS NULL) OR (state = 'sealed' AND sealed_at IS NOT NULL))
) STRICT;
INSERT INTO artifact_generation_status VALUES (1, 'active', NULL);
CREATE TRIGGER artifact_generation_status_retained BEFORE DELETE ON artifact_generation_status
BEGIN SELECT RAISE(ABORT, 'Artifact generation status is retained'); END;
CREATE TRIGGER artifact_generation_status_no_replacement BEFORE INSERT ON artifact_generation_status
WHEN EXISTS (SELECT 1 FROM artifact_generation_status)
BEGIN SELECT RAISE(ABORT, 'Artifact generation status cannot be replaced'); END;
CREATE TRIGGER artifact_generation_status_sealed BEFORE UPDATE ON artifact_generation_status
WHEN OLD.state = 'sealed' OR NEW.state != 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation cannot be unsealed'); END;
CREATE TRIGGER artifacts_generation_insert BEFORE INSERT ON artifacts
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER artifacts_generation_update BEFORE UPDATE ON artifacts
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER artifacts_generation_delete BEFORE DELETE ON artifacts
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER artifact_metadata_generation_insert BEFORE INSERT ON artifact_metadata
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER artifact_metadata_generation_update BEFORE UPDATE ON artifact_metadata
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER artifact_metadata_generation_delete BEFORE DELETE ON artifact_metadata
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER creation_requests_generation_insert BEFORE INSERT ON creation_requests
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER creation_requests_generation_update BEFORE UPDATE ON creation_requests
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER creation_requests_generation_delete BEFORE DELETE ON creation_requests
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER blob_intents_generation_insert BEFORE INSERT ON blob_intents
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER blob_intents_generation_update BEFORE UPDATE ON blob_intents
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER blob_intents_generation_delete BEFORE DELETE ON blob_intents
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER blob_deletions_generation_insert BEFORE INSERT ON blob_deletions
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER blob_deletions_generation_update BEFORE UPDATE ON blob_deletions
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER blob_deletions_generation_delete BEFORE DELETE ON blob_deletions
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER blob_gc_completed_generation_insert BEFORE INSERT ON blob_gc_completed
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER blob_gc_completed_generation_update BEFORE UPDATE ON blob_gc_completed
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER blob_gc_completed_generation_delete BEFORE DELETE ON blob_gc_completed
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER intent_cleanup_generation_insert BEFORE INSERT ON intent_cleanup
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER intent_cleanup_generation_update BEFORE UPDATE ON intent_cleanup
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER intent_cleanup_generation_delete BEFORE DELETE ON intent_cleanup
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER artifact_blob_pins_generation_insert BEFORE INSERT ON artifact_blob_pins
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER artifact_blob_pins_generation_update BEFORE UPDATE ON artifact_blob_pins
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER artifact_blob_pins_generation_delete BEFORE DELETE ON artifact_blob_pins
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER artifact_maintenance_progress_generation_insert BEFORE INSERT ON artifact_maintenance_progress
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER artifact_maintenance_progress_generation_update BEFORE UPDATE ON artifact_maintenance_progress
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER artifact_maintenance_progress_generation_delete BEFORE DELETE ON artifact_maintenance_progress
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER artifact_catalog_generation_insert BEFORE INSERT ON artifact_catalog
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER artifact_catalog_generation_update BEFORE UPDATE ON artifact_catalog
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER artifact_catalog_generation_delete BEFORE DELETE ON artifact_catalog
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER artifact_storage_generation_generation_insert BEFORE INSERT ON artifact_storage_generation
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER artifact_storage_generation_generation_update BEFORE UPDATE ON artifact_storage_generation
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER artifact_storage_generation_generation_delete BEFORE DELETE ON artifact_storage_generation
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER store_resource_requirements_generation_insert BEFORE INSERT ON store_resource_requirements
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER store_resource_requirements_generation_update BEFORE UPDATE ON store_resource_requirements
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER store_resource_requirements_generation_delete BEFORE DELETE ON store_resource_requirements
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER schema_migrations_generation_insert BEFORE INSERT ON schema_migrations
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER schema_migrations_generation_update BEFORE UPDATE ON schema_migrations
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER schema_migrations_generation_delete BEFORE DELETE ON schema_migrations
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
