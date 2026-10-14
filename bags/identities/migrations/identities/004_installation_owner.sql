-- Pin the actor's durable key so later user creation cannot change operator ownership.
CREATE UNIQUE INDEX actors_ownership_key ON actors(id, token, type);
CREATE TABLE installation_owner (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  actor_id INTEGER NOT NULL CHECK(actor_id > 0 AND actor_id <= 9007199254740991),
  actor_token TEXT NOT NULL CHECK(length(actor_token) BETWEEN 1 AND 256),
  actor_type TEXT NOT NULL DEFAULT 'user' CHECK(actor_type = 'user'),
  bound_at INTEGER NOT NULL CHECK(typeof(bound_at) = 'integer' AND bound_at >= 0),
  FOREIGN KEY(actor_id, actor_token, actor_type) REFERENCES actors(id, token, type)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

-- A sole existing user is unambiguous; empty/multiple-user installations require explicit selection.
INSERT INTO installation_owner(singleton, actor_id, actor_token, bound_at)
SELECT 1, id, token, CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM actors WHERE type = 'user' AND (SELECT COUNT(*) FROM actors WHERE type = 'user') = 1;
