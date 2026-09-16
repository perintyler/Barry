-- QA seed data for @barry-rocks/db
--
-- Rewritten 2026-08-26. The previous version was unrunnable: it targeted ten
-- tables of which SEVEN no longer exist (agent_questions, conversations,
-- prompts, bash_commands, changes, tasks, web_sessions), so it failed on its
-- first DELETE. The three surviving tables had been reshaped too, so its
-- INSERTs named columns like `working_directory` and `conversation_id` that
-- are gone as well.
--
-- Two schema facts this file depends on, both easy to get wrong:
--
--   * There is no `agent_questions` table and there never was one. An agent
--     question is a row in `messages` with `metadata->>'type' =
--     'agent_question'`, carrying its status and payload in that same blob.
--     That is why the questions API reads and writes messages.
--   * `sessions.agent_token` is NOT NULL, as are id/active/state/status/
--     traits/metadata/created_at. A seed omitting any of them fails.
--
-- Keep the order below: messages, events and action_runs all carry a foreign
-- key to sessions.

-- ============================================================================
-- Clear existing data (children before parents)
-- ============================================================================

DELETE FROM action_runs;
DELETE FROM events;
DELETE FROM messages;
DELETE FROM sessions;
-- Scoped, unlike the rest: `settings` holds real configuration, and the old
-- seed's unqualified DELETE would have wiped it.
DELETE FROM settings WHERE scope = 'qa';

-- ============================================================================
-- Sessions (3)
--
-- `state` is the row's lifecycle (open|closed|archived) and `status` is the
-- run state (pending|planning|running|completed|failed|cancelled). Both are
-- CHECK-constrained and they are NOT the same axis -- a closed session can
-- still be 'completed', and 'idle'/'working' belong to neither.
-- ============================================================================

INSERT INTO sessions (id, active, state, status, system_prompt, summary, traits, metadata, agent_token, created_at, completed_at) VALUES
  ('qa-session-001', false, 'closed', 'completed',
   'Fix the retry loop in the database client.',
   'Added exponential backoff to the retry loop.',
   '["coding"]'::jsonb, '{}'::jsonb, 'qa-token-001',
   NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour'),

  ('qa-session-002', true, 'open', 'running',
   'Investigate the failing integration tests.',
   NULL,
   '["coding","qa"]'::jsonb, '{}'::jsonb, 'qa-token-002',
   NOW() - INTERVAL '30 minutes', NULL),

  ('qa-session-003', false, 'open', 'pending',
   'Draft release notes for 1.4.',
   NULL,
   '[]'::jsonb, '{}'::jsonb, 'qa-token-003',
   NOW() - INTERVAL '10 minutes', NULL);

-- ============================================================================
-- Messages (4), two of them agent questions
--
-- `sequence` is per session and monotonic; the questions API allocates the
-- next one when it records a question.
-- ============================================================================

INSERT INTO messages (id, session_id, type, sequence, role, content, content_text, metadata, created_at) VALUES
  ('qa-message-001', 'qa-session-001', 'message', 1, 'user',
   '[{"type":"text","text":"The client gives up too early on a flaky connection."}]'::jsonb,
   'The client gives up too early on a flaky connection.',
   '{}'::jsonb, NOW() - INTERVAL '2 hours'),

  ('qa-message-002', 'qa-session-001', 'message', 2, 'assistant',
   '[{"type":"text","text":"Added exponential backoff with a cap of five attempts."}]'::jsonb,
   'Added exponential backoff with a cap of five attempts.',
   '{}'::jsonb, NOW() - INTERVAL '105 minutes'),

  -- ANSWERED agent question. Note the shape: payload, status and answer all
  -- live in metadata, not in columns.
  ('qa-message-003', 'qa-session-001', 'message', 3, 'assistant',
   '[{"type":"text","text":"Agent question"}]'::jsonb,
   NULL,
   '{"type":"agent_question","status":"answered","payload":{"questions":[{"question":"Which backoff strategy?","header":"Backoff","options":[{"label":"Exponential","description":"Double each attempt"},{"label":"Linear","description":"Fixed increment"}],"multiSelect":false}]},"answer":{"answers":{"Backoff":"Exponential"}},"answered_at":"2026-08-26T00:00:00.000Z"}'::jsonb,
   NOW() - INTERVAL '100 minutes'),

  -- PENDING agent question, so the answer path has something to act on and
  -- `getPendingQuestions` returns a non-empty result.
  ('qa-message-004', 'qa-session-002', 'message', 1, 'assistant',
   '[{"type":"text","text":"Agent question"}]'::jsonb,
   NULL,
   '{"type":"agent_question","status":"pending","payload":{"questions":[{"question":"Deploy to staging?","header":"Deploy","options":[{"label":"Yes","description":"Ship it"},{"label":"No","description":"Hold"}],"multiSelect":false}]}}'::jsonb,
   NOW() - INTERVAL '20 minutes');

-- ============================================================================
-- Events (3) -- covering the severities the feed styles differently
-- ============================================================================

INSERT INTO events (id, type, session_id, source, title, body, severity, data, metadata, created_at) VALUES
  ('evt-qa-001', 'progress', 'qa-session-001', 'agent',
   'Building', 'Applying the retry fix.', 'info',
   '{"phase":"building"}'::jsonb, '{}'::jsonb, NOW() - INTERVAL '110 minutes'),

  ('evt-qa-002', 'task_finished', 'qa-session-001', 'agent',
   'Retry loop fixed', 'Tests pass.', 'success',
   '{"phase":"complete"}'::jsonb, '{}'::jsonb, NOW() - INTERVAL '1 hour'),

  -- Session-less and unread on purpose: events outlive their session
  -- (session_id is ON DELETE SET NULL), and the unread badge needs a subject.
  ('evt-qa-003', 'system_alert', NULL, 'system',
   'Disk almost full', '92% used on the primary volume.', 'warn',
   '{}'::jsonb, '{}'::jsonb, NOW() - INTERVAL '15 minutes');

-- ============================================================================
-- Action runs (2) -- one complete, one still open
--
-- An open run is exactly what `list-open-action-runs` exists to find, so QA
-- needs one that is genuinely unclosed.
-- ============================================================================

-- `bag` and `metadata` are NOT NULL, and the timestamp is `started_at` --
-- there is no `created_at` on this table.
INSERT INTO action_runs (id, action, bag, session_id, status, summary, metadata, started_at, completed_at) VALUES
  ('arn-qa-001', 'wrap-up', 'sessions', 'qa-session-001', 'complete',
   'Summarized the retry fix.', '{}'::jsonb,
   NOW() - INTERVAL '65 minutes', NOW() - INTERVAL '62 minutes'),
  ('arn-qa-002', 'preflight-code-check', 'git', 'qa-session-002', 'started',
   NULL, '{}'::jsonb,
   NOW() - INTERVAL '25 minutes', NULL);

-- ============================================================================
-- Settings (2), scoped to 'qa' so the cleanup above cannot touch real rows
-- ============================================================================

INSERT INTO settings (scope, scope_id, key, value) VALUES
  ('qa', 'qa-session-001', 'theme', '"dark"'::jsonb),
  ('qa', 'qa-session-002', 'notifications', '{"enabled":true}'::jsonb);

-- ============================================================================
-- Summary
-- ============================================================================
-- Sessions:    3 (completed, running, pending)
-- Messages:    4 (2 plain, 1 answered question, 1 pending question)
-- Events:      3 (info, success, warn -- one session-less and unread)
-- Action runs: 2 (1 complete, 1 open)
-- Settings:    2 (scope 'qa')
