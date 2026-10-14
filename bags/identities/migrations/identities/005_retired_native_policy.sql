DELETE FROM traits WHERE bag IS NULL AND name = 'no-native-tools';
DELETE FROM traits
WHERE bag IN ('claude', 'codex', 'cursor', 'opencode', 'pi', 'antigravity')
  AND name LIKE bag || ':no-%';

DELETE FROM bounds
WHERE json_extract(metadata, '$.bag') IN ('claude', 'codex', 'cursor', 'opencode', 'pi', 'antigravity')
  AND (name LIKE '%:legacy-%' OR name LIKE '%:guard-network'
    OR name = 'claude:baseline' OR name IN ('codex:no-native-tools', 'opencode:no-native-tools'));

UPDATE traits SET metadata = json_remove(metadata, '$.harnessTraits')
WHERE json_type(metadata, '$.harnessTraits') = 'object'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(traits.metadata, '$.harnessTraits') AS target
    JOIN traits AS remaining ON remaining.name = target.value
  );
