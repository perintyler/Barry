
      -- A collection is one bag's slice of the store. Namespacing by collection
      -- is what makes this general: sessions-search owns "session-messages",
      -- anything else owns its own, and neither can see the other's rows.
      CREATE TABLE collections (
        name       TEXT PRIMARY KEY,
        -- The model and dimension this collection was BUILT with. Recorded
        -- because vectors from two models are not comparable even when they
        -- are the same length: the geometry is unrelated, so a mismatched
        -- search returns plausible-looking nonsense rather than an error.
        -- searchCollection refuses on mismatch for exactly that reason.
        model      TEXT NOT NULL,
        dim        INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE vectors (
        collection  TEXT NOT NULL REFERENCES collections(name) ON DELETE CASCADE,
        -- The owning bag's id for this row. Opaque here; the caller decides
        -- what it means (for sessions-search it is "<session_id>:<sequence>").
        external_id TEXT NOT NULL,
        -- The text that was embedded, kept so a result can be shown without a
        -- second round trip to whatever system owns the original.
        text        TEXT NOT NULL,
        -- Float32 little-endian, L2-NORMALIZED AT WRITE TIME. Normalizing on
        -- the way in turns cosine similarity into a plain dot product, which
        -- is what makes the brute-force scan cheap enough to need no index.
        vector      BLOB NOT NULL,
        -- Free-form JSON the caller can filter or display on. Not indexed.
        metadata    TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (collection, external_id)
      );

      CREATE INDEX idx_vectors_collection ON vectors (collection);
    