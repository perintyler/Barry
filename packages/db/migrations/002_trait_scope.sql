-- Traits can carry an embedded scope (restrictions) alongside their grants.
-- Merged (union of denials) with profile/session scopes at resolution time.
-- Lets a trait bundle a policy with its capabilities — e.g. the `coding` trait
-- grants git tools but denies raw git/gh in Bash so all git goes through the
-- structured git_* tools.
ALTER TABLE traits ADD COLUMN scope JSONB NOT NULL DEFAULT '{}';

-- Migrate profiles off the retired `core` trait. `core` split into the default
-- set (coding + sessions + docs-media), which every session now gets
-- automatically — so we simply drop `core` from any profile's trait list.
-- Profiles that named additional traits keep them.
UPDATE profiles
SET metadata = jsonb_set(
  metadata,
  '{traits}',
  COALESCE(
    (SELECT jsonb_agg(t) FROM jsonb_array_elements_text(metadata->'traits') AS t WHERE t <> 'core'),
    '[]'::jsonb
  )
)
WHERE metadata->'traits' @> '"core"'::jsonb;
