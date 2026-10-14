
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        -- A plain column, not a foreign key. Events outlive their session on
        -- purpose ("an event is a log of something that happened, not part of
        -- the session's state"), sessions live in their own store, and nothing
        -- joins the two — callers pass ids in and merge in application code. A
        -- session id whose session is gone reads the same as NULL to every
        -- consumer: no session to open.
        session_id TEXT,
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        severity TEXT NOT NULL DEFAULT 'info',
        -- JSON text. SQLite has no JSONB; these are read whole, never queried
        -- by key, so json_extract is not needed.
        data TEXT NOT NULL DEFAULT '{}',
        metadata TEXT NOT NULL DEFAULT '{}',
        -- JSON array of channel names. The shape callers see is unchanged.
        delivered_via TEXT NOT NULL DEFAULT '[]',
        read_at TEXT,
        created_at TEXT NOT NULL,
        -- Insertion order, and the tiebreak the feed actually sorts on.
        --
        -- created_at has millisecond resolution, and a burst writes several
        -- events inside one millisecond — the jobs sweep does it routinely.
        -- Ordering those by id would order them by a random nanoid, so the
        -- feed would shuffle rows that arrived in a known order and a keyset
        -- page boundary landing mid-burst could repeat or drop one.
        seq INTEGER NOT NULL
      );

      -- The feed pages by created_at, the session lookups filter by
      -- session_id, and the unread badge counts unread rows.
      CREATE INDEX idx_events_created_at ON events(created_at DESC, seq DESC);
      CREATE INDEX idx_events_session_id ON events(session_id) WHERE session_id IS NOT NULL;
      CREATE INDEX idx_events_type ON events(type, created_at DESC);
      CREATE INDEX idx_events_unread ON events(created_at DESC, seq DESC) WHERE read_at IS NULL;
    