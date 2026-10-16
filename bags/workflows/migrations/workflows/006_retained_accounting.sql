-- Recalculate legacy retained bytes in bounded backfill turns. Existing effects,
-- receipts, grants and idempotency records are preserved. Open runs retain their
-- control reservation; terminal runs are charged for retained records.
UPDATE workflow_runs SET budget_bytes=0;
UPDATE workflow_meta SET value='0' WHERE key='reserved-bytes';
UPDATE workflow_meta SET value=CASE WHEN EXISTS(SELECT 1 FROM workflow_runs) THEN '0' ELSE '1' END WHERE key='bytes-accounted';
DELETE FROM workflow_byte_backfill;
