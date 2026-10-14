
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,                -- markdown
        -- Normalized repo slug (github.com/owner/name) or an absolute path for
        -- a repo with no remote. NULL means global: visible in every repo.
        repo TEXT,
        mode TEXT NOT NULL DEFAULT 'on-demand' CHECK (mode IN ('always','on-demand')),
        source TEXT NOT NULL CHECK (source IN ('agent','manual','import')),
        session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,                  -- soft delete; hidden everywhere by default
        last_accessed_at TEXT              -- ranking signal, bumped by get
      );
      CREATE TABLE memory_tags (
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY (memory_id, tag)
      );
      CREATE INDEX idx_memories_repo ON memories(repo) WHERE archived_at IS NULL;
      CREATE INDEX idx_memory_tags_tag ON memory_tags(tag);

      -- A regular FTS5 table (text stored), NOT contentless: snippet() and
      -- highlight() need stored text, and search results without snippets
      -- force a get per hit. Bodies are small; the duplication is noise.
      -- rowid is pinned to memories.rowid so the store layer can sync by id.
      -- Sync happens in the store's single write path, not triggers — tags
      -- live in their own table, so a trigger on memories alone could never
      -- index them.
      CREATE VIRTUAL TABLE memories_fts USING fts5(title, body, tags);
    