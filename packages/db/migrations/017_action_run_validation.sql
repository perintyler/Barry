-- Action validation verdicts (phase 2).
--
-- `status` gains 'failed': a run whose declared post-conditions did not hold.
-- It is still a CLOSED run — the work happened, the check did not pass — so it
-- must not be confused with 'started', which means nobody ever closed it.
--
-- validation_failures is NULL when an action declared no checks, and an empty
-- array when it declared checks that all passed. That distinction is the whole
-- point: "not validated" and "validated clean" are different claims, and
-- collapsing them would let an unchecked action read as a verified one.

ALTER TABLE action_runs
  ADD COLUMN validated_at TIMESTAMPTZ,
  ADD COLUMN validation_failures JSONB;

COMMENT ON COLUMN action_runs.validated_at IS
  'When post-conditions were checked. NULL = the action declared none.';
COMMENT ON COLUMN action_runs.validation_failures IS
  'Failed check descriptions. NULL = not validated; [] = validated, all passed.';
