ALTER TABLE workflow_commands ADD COLUMN work_eligible_at INTEGER;
ALTER TABLE workflow_commands ADD COLUMN work_dispatch_deadline INTEGER;
-- Retained commands keep their original timing; only newly scheduled generic activities use these windows.
CREATE TRIGGER workflow_work_dispatch_window_immutable BEFORE UPDATE OF work_eligible_at,work_dispatch_deadline ON workflow_commands
WHEN OLD.work_eligible_at IS NOT NEW.work_eligible_at OR OLD.work_dispatch_deadline IS NOT NEW.work_dispatch_deadline
BEGIN SELECT RAISE(ABORT,'eligible dispatch window is immutable'); END;
