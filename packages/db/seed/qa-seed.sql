-- QA Seed Data for @barry/db
-- This file seeds the barry_qa database with test data for QA verification

-- ============================================================================
-- Clear existing data (in correct order due to foreign keys)
-- ============================================================================

DELETE FROM embeddings;
DELETE FROM messages;
DELETE FROM conversations;
DELETE FROM prompts;
DELETE FROM agent_questions;
DELETE FROM bash_commands;
DELETE FROM changes;
DELETE FROM sessions;
DELETE FROM settings;
DELETE FROM web_sessions;
DELETE FROM tasks;

-- ============================================================================
-- Sessions (3 test sessions)
-- ============================================================================

INSERT INTO sessions (id, status, started_at, ended_at, working_directory, git_branch, git_remote, transcript_path, permission_mode, source, end_reason, hostname, "user", directive, name, web_enabled) VALUES
  ('qa-session-001', 'active', NOW() - INTERVAL '1 hour', NULL, '/Users/test/projects/app', 'main', 'origin', '/tmp/transcripts/qa-001.jsonl', 'default', 'cli', NULL, 'test-host', 'testuser', 'Build the login feature', 'Login Feature', true),
  ('qa-session-002', 'ended', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour', '/Users/test/projects/api', 'feature/auth', 'origin', '/tmp/transcripts/qa-002.jsonl', 'bypassPermissions', 'web', 'completed', 'test-host', 'testuser', 'Fix the authentication bug', 'Auth Bug Fix', true),
  ('qa-session-003', 'crashed', NOW() - INTERVAL '3 hours', NOW() - INTERVAL '2.5 hours', '/Users/test/projects/lib', 'develop', 'upstream', NULL, 'default', 'cli', 'error', 'test-host', 'admin', 'Refactor the utils module', 'Utils Refactor', false);

-- ============================================================================
-- Prompts (5 test prompts across sessions)
-- ============================================================================

INSERT INTO prompts (session_id, content, created_at) VALUES
  ('qa-session-001', 'Create a login form component', NOW() - INTERVAL '55 minutes'),
  ('qa-session-001', 'Add validation to the form', NOW() - INTERVAL '45 minutes'),
  ('qa-session-002', 'Debug the JWT token refresh issue', NOW() - INTERVAL '1.5 hours'),
  ('qa-session-002', 'Add unit tests for the fix', NOW() - INTERVAL '1.2 hours'),
  ('qa-session-003', 'Extract helper functions into a new file', NOW() - INTERVAL '2.8 hours');

-- ============================================================================
-- Changes (6 test changes)
-- ============================================================================

INSERT INTO changes (session_id, tool, file_path, old_content, new_content, working_directory, edit_index, created_at) VALUES
  ('qa-session-001', 'Write', '/src/components/LoginForm.tsx', NULL, 'export function LoginForm() { return <form>...</form>; }', '/Users/test/projects/app', NULL, NOW() - INTERVAL '50 minutes'),
  ('qa-session-001', 'Edit', '/src/components/LoginForm.tsx', 'return <form>...</form>;', 'return <form onSubmit={handleSubmit}>...</form>;', '/Users/test/projects/app', 1, NOW() - INTERVAL '40 minutes'),
  ('qa-session-002', 'Edit', '/src/auth/jwt.ts', 'const TOKEN_EXPIRY = 3600;', 'const TOKEN_EXPIRY = 7200;', '/Users/test/projects/api', 1, NOW() - INTERVAL '1.4 hours'),
  ('qa-session-002', 'Edit', '/src/auth/jwt.ts', 'function refresh() {}', 'function refresh() { /* implementation */ }', '/Users/test/projects/api', 2, NOW() - INTERVAL '1.3 hours'),
  ('qa-session-002', 'Write', '/src/auth/__tests__/jwt.test.ts', NULL, 'describe("JWT", () => { it("should refresh", () => {}); });', '/Users/test/projects/api', NULL, NOW() - INTERVAL '1.1 hours'),
  ('qa-session-003', 'MultiEdit', '/src/utils/helpers.ts', 'function a() {} function b() {}', 'export function a() {} export function b() {}', '/Users/test/projects/lib', 1, NOW() - INTERVAL '2.7 hours');

-- ============================================================================
-- Bash Commands (8 test commands)
-- ============================================================================

INSERT INTO bash_commands (session_id, command, description, cwd, exit_code, stdout, stderr, started_at, ended_at, duration_ms, background, truncated) VALUES
  ('qa-session-001', 'npm install', 'Install dependencies', '/Users/test/projects/app', 0, 'added 150 packages', '', NOW() - INTERVAL '58 minutes', NOW() - INTERVAL '57 minutes', 45000, false, false),
  ('qa-session-001', 'npm run dev', 'Start dev server', '/Users/test/projects/app', NULL, '', '', NOW() - INTERVAL '54 minutes', NULL, NULL, true, false),
  ('qa-session-001', 'npm test', 'Run tests', '/Users/test/projects/app', 0, 'Tests: 5 passed', '', NOW() - INTERVAL '35 minutes', NOW() - INTERVAL '34 minutes', 8500, false, false),
  ('qa-session-002', 'git status', 'Check git status', '/Users/test/projects/api', 0, 'On branch feature/auth', '', NOW() - INTERVAL '1.6 hours', NOW() - INTERVAL '1.6 hours', 120, false, false),
  ('qa-session-002', 'npm test -- --coverage', 'Run tests with coverage', '/Users/test/projects/api', 0, 'Coverage: 85%', '', NOW() - INTERVAL '1.05 hours', NOW() - INTERVAL '1 hour', 25000, false, false),
  ('qa-session-003', 'npm run build', 'Build project', '/Users/test/projects/lib', 1, '', 'Error: Missing dependency', NOW() - INTERVAL '2.6 hours', NOW() - INTERVAL '2.55 hours', 5000, false, false),
  ('qa-session-003', 'cat package.json', 'View package.json', '/Users/test/projects/lib', 0, '{"name": "lib", "version": "1.0.0"}', '', NOW() - INTERVAL '2.5 hours', NOW() - INTERVAL '2.5 hours', 50, false, false),
  ('qa-session-001', 'echo "hello world" | wc -c', 'Count characters', '/Users/test/projects/app', 0, '12', '', NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '30 minutes', 30, false, false);

-- ============================================================================
-- Agent Questions (3 test questions)
-- ============================================================================

INSERT INTO agent_questions (id, session_id, payload, answer, status, created_at, answered_at) VALUES
  ('qa-question-001', 'qa-session-001', '{"question": "Which database should we use?", "options": ["PostgreSQL", "MySQL", "SQLite"]}', '{"selected": "PostgreSQL"}', 'answered', NOW() - INTERVAL '52 minutes', NOW() - INTERVAL '51 minutes'),
  ('qa-question-002', 'qa-session-001', '{"question": "Add dark mode support?", "options": ["Yes", "No", "Later"]}', NULL, 'pending', NOW() - INTERVAL '20 minutes', NULL),
  ('qa-question-003', 'qa-session-002', '{"question": "Deploy to staging?", "options": ["Yes", "No"]}', '{"selected": "Yes"}', 'answered', NOW() - INTERVAL '1.1 hours', NOW() - INTERVAL '1.05 hours');

-- ============================================================================
-- Conversations (2 test conversations)
-- ============================================================================

INSERT INTO conversations (id, title, participants, created_at, updated_at) VALUES
  ('qa-conv-001', 'Project Planning', '["Alice", "Bob"]', NOW() - INTERVAL '5 hours', NOW() - INTERVAL '4 hours'),
  ('qa-conv-002', 'Bug Discussion', '["Charlie", "Diana", "Eve"]', NOW() - INTERVAL '3 hours', NOW() - INTERVAL '2 hours');

-- ============================================================================
-- Messages (8 test messages)
-- ============================================================================

INSERT INTO messages (id, conversation_id, person, content, role, timestamp, metadata) VALUES
  ('qa-msg-001', 'qa-conv-001', 'Alice', 'Let''s start planning the new feature', 'user', NOW() - INTERVAL '5 hours', '{"priority": "high"}'),
  ('qa-msg-002', 'qa-conv-001', 'Bob', 'I think we should focus on the API first', 'user', NOW() - INTERVAL '4.8 hours', NULL),
  ('qa-msg-003', 'qa-conv-001', 'Alice', 'Good idea, let me create a draft', 'user', NOW() - INTERVAL '4.5 hours', NULL),
  ('qa-msg-004', 'qa-conv-001', 'assistant', 'Based on your discussion, I suggest starting with the authentication module', 'assistant', NOW() - INTERVAL '4 hours', '{"confidence": 0.9}'),
  ('qa-msg-005', 'qa-conv-002', 'Charlie', 'Found a bug in the payment processing', 'user', NOW() - INTERVAL '3 hours', '{"severity": "critical"}'),
  ('qa-msg-006', 'qa-conv-002', 'Diana', 'Can you share the error logs?', 'user', NOW() - INTERVAL '2.8 hours', NULL),
  ('qa-msg-007', 'qa-conv-002', 'Charlie', 'Here they are: NullPointerException at line 42', 'user', NOW() - INTERVAL '2.5 hours', NULL),
  ('qa-msg-008', 'qa-conv-002', 'Eve', 'I''ll take a look at this', 'user', NOW() - INTERVAL '2 hours', NULL);

-- ============================================================================
-- Settings (5 test settings)
-- ============================================================================

INSERT INTO settings (key, value, type, description, updated_at) VALUES
  ('theme', '"dark"', 'string', 'UI theme preference', NOW() - INTERVAL '1 day'),
  ('max_sessions', '10', 'number', 'Maximum concurrent sessions', NOW() - INTERVAL '2 days'),
  ('notifications_enabled', 'true', 'boolean', 'Enable notifications', NOW() - INTERVAL '3 days'),
  ('default_model', '"claude-opus-4-6"', 'string', 'Default AI model (see packages/agent-runtime/src/models.ts for the catalog)', NOW() - INTERVAL '1 day'),
  ('api_keys', '{"openai": "sk-***", "anthropic": "sk-ant-***"}', 'json', 'API keys (redacted)', NOW() - INTERVAL '5 days');

-- ============================================================================
-- Web Sessions (2 test web sessions)
-- ============================================================================

INSERT INTO web_sessions (id, expires) VALUES
  ('qa-web-session-001', EXTRACT(EPOCH FROM NOW() + INTERVAL '1 day') * 1000),
  ('qa-web-session-expired', EXTRACT(EPOCH FROM NOW() - INTERVAL '1 day') * 1000);

-- ============================================================================
-- Tasks (4 test tasks)
-- ============================================================================

INSERT INTO tasks (id, status, branch, channel_id, channel_name, thread_ts, user_id, user_email, repo, prompt, mode, summary, error, created_at, started_at, completed_at) VALUES
  ('qa-task-001', 'completed', 'feature/login', 'C123456789', 'dev-requests', '1234567890.123456', 'U001', 'alice@test.com', 'test/app', 'Add login feature', 'standard', 'Successfully added login feature with validation', NULL, NOW() - INTERVAL '6 hours', NOW() - INTERVAL '5.9 hours', NOW() - INTERVAL '4 hours'),
  ('qa-task-002', 'in_progress', 'fix/auth-bug', 'C123456789', 'dev-requests', '1234567890.234567', 'U002', 'bob@test.com', 'test/api', 'Fix authentication bug', 'bypass', NULL, NULL, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1.9 hours', NULL),
  ('qa-task-003', 'pending', NULL, 'C987654321', 'urgent-bugs', '1234567890.345678', 'U003', 'charlie@test.com', 'test/lib', 'Refactor utils module', 'standard', NULL, NULL, NOW() - INTERVAL '1 hour', NULL, NULL),
  ('qa-task-004', 'failed', 'test/broken', 'C123456789', 'dev-requests', '1234567890.456789', 'U001', 'alice@test.com', 'test/broken', 'Fix broken tests', 'standard', NULL, 'Module not found: @missing/package', NOW() - INTERVAL '12 hours', NOW() - INTERVAL '11.9 hours', NOW() - INTERVAL '11 hours');

-- ============================================================================
-- Summary
-- ============================================================================
-- Sessions: 3 (1 active, 1 ended, 1 crashed)
-- Prompts: 5
-- Changes: 6 (Write: 2, Edit: 3, MultiEdit: 1)
-- Bash Commands: 8 (including 1 background, 1 failed)
-- Agent Questions: 3 (2 answered, 1 pending)
-- Conversations: 2
-- Messages: 8
-- Settings: 5 (string, number, boolean, json types)
-- Web Sessions: 2 (1 valid, 1 expired)
-- Tasks: 4 (completed, in_progress, pending, failed)
