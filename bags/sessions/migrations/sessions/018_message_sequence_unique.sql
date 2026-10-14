-- A message's sequence is unique within its session from here on, enforced by
-- the schema rather than by one writer's in-memory counter. Every process
-- that appends a message opens this store itself, and a sequence is assigned
-- inside the insert's transaction: the next one after the session's highest.
--
-- History has duplicates: two writers each believed their counter, and a pair
-- of messages shares one (session_id, sequence). They are renumbered first,
-- moving as few rows as possible. Within a session, ordered by (sequence,
-- created_at, rowid), row i gets
--
--   i + max over j <= i of (sequence_j - j)
--
-- which is the smallest strictly increasing numbering that never lowers a
-- sequence: a row that needs no room keeps its number, a duplicate moves up by
-- one, and the rows after it move only until a gap in the old numbering
-- absorbs the shift. Order is preserved.
--
-- The search extension keys its vectors by `<session>:<sequence>` and keeps a
-- watermark of the highest sequence it embedded. A renumbered session loses
-- its watermark, so the next sweep embeds it again from the start; vectors are
-- upserted by key, and no sequence went down, so every stale key is
-- overwritten.

CREATE TEMP TABLE message_sequence_renumber AS
WITH affected AS (
  SELECT DISTINCT session_id
    FROM messages
   WHERE session_id IS NOT NULL
   GROUP BY session_id, sequence
  HAVING COUNT(*) > 1
),
ordered AS (
  SELECT m.id,
         m.session_id,
         m.sequence,
         ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.sequence, m.created_at, m.rowid) - 1 AS position
    FROM messages m
    JOIN affected a ON a.session_id = m.session_id
),
renumbered AS (
  SELECT id,
         session_id,
         sequence AS old_sequence,
         position + MAX(sequence - position) OVER (
           PARTITION BY session_id ORDER BY position ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         ) AS new_sequence
    FROM ordered
)
SELECT id, session_id, new_sequence
  FROM renumbered
 WHERE new_sequence != old_sequence;

-- Looked up once per moved row; without the index each lookup scans them all.
CREATE INDEX temp.message_sequence_renumber_id ON message_sequence_renumber (id);

UPDATE messages
   SET sequence = (SELECT r.new_sequence FROM message_sequence_renumber r WHERE r.id = messages.id)
 WHERE id IN (SELECT id FROM message_sequence_renumber);

UPDATE sessions
   SET metadata = json_remove(metadata, '$.embedding_watermark_seq')
 WHERE id IN (SELECT DISTINCT session_id FROM message_sequence_renumber)
   AND json_valid(metadata);

DROP TABLE message_sequence_renumber;

DROP INDEX IF EXISTS idx_messages_session_sequence;
CREATE UNIQUE INDEX idx_messages_session_sequence ON messages (session_id, sequence);
