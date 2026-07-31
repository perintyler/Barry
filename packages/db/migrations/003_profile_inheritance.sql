ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES profiles(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_profiles_parent_id ON profiles(parent_id);
