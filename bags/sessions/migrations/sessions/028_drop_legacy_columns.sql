UPDATE sessions
SET bags = traits
WHERE (bags IS NULL OR bags = '[]')
  AND traits IS NOT NULL
  AND traits <> '[]';

ALTER TABLE sessions DROP COLUMN traits;
ALTER TABLE sessions DROP COLUMN bound_id;
