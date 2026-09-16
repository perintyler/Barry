-- Instructions a trait points at.
--
-- Traits could grant tools (`namespaces`) and mount prose-as-procedure
-- (`skills`), but nothing trait-shaped ever reached the system prompt. Standing
-- guidance therefore had only two homes: a bag's own `instructions/` dir, which
-- applies to every session enabling that bag regardless of what the session is
-- doing, or nothing at all.
--
-- This is the twin of `skills`: a JSONB array of instruction NAMES, not bodies.
-- The text stays in its instruction file, under the existing budgets, resolved
-- through the same catalog. Storing bodies here would put prose in two places
-- and add a sync that fails silently — the failure already recorded for the bag
-- registry, where editing YAML alone was a no-op.
--
-- A trait naming an instruction contributes a short pointer to the prompt
-- ("when doing X, fetch Y"), while the body stays on-demand. That keeps the
-- standing cost at roughly one sentence instead of the whole instruction.

ALTER TABLE traits
  ADD COLUMN instructions JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN traits.instructions IS
  'JSONB array of instruction names this trait points at. Names, not bodies — the text lives in its instruction file and resolves through the instruction catalog.';
