-- 001_initial.sql
-- Fresh schema for Barry database

-- 1. actors (STI: user | agent)
CREATE TABLE actors (
  id SERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('user', 'agent')),
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  username TEXT,
  settings JSONB DEFAULT '{}',
  provider TEXT,
  models JSONB DEFAULT '[]',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. traits
CREATE TABLE traits (
  id SERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  tools JSONB DEFAULT '[]',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. profiles
CREATE TABLE profiles (
  id SERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  actor_id INTEGER NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

SELECT a.name, COUNT(s.id) as session_count
FROM actors a
LEFT JOIN sessions s ON s.actor_id = a.id
WHERE a.type = 'user'
GROUP BY a.name
ORDER BY session_count DESC
LIMIT 10;
