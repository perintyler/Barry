DROP TABLE IF EXISTS artifact_schema_migrations;
CREATE TABLE IF NOT EXISTS store_resource_requirements (
  name TEXT PRIMARY KEY
) STRICT;
INSERT OR IGNORE INTO store_resource_requirements VALUES ('blobs');
