-- Reclassify retained live facts without changing canonical evidence or cursor order.
UPDATE workflow_work_index SET state=(
  SELECT CASE
    WHEN json_extract(a.record,'$.facts.stop_requested')=1 OR json_extract(a.record,'$.facts.coordinator') IN ('cancelled','timed_out') THEN 'stopping'
    WHEN json_extract(a.record,'$.facts.wait')='human-decision' THEN 'waiting-for-approval'
    WHEN json_extract(a.record,'$.facts.wait')!='none' THEN 'waiting'
    WHEN json_extract(a.record,'$.facts.phase')='queued' THEN 'queued'
    ELSE 'running' END
  FROM workflow_work_admissions a WHERE a.run_id=workflow_work_index.run_id
) WHERE EXISTS (
  SELECT 1 FROM workflow_work_admissions a WHERE a.run_id=workflow_work_index.run_id
    AND json_extract(a.record,'$.facts.physical')='running'
    AND json_extract(a.record,'$.facts.effect')='uncertain'
    AND (json_extract(a.record,'$.facts.coordinator')='running' OR (
      json_extract(a.record,'$.facts.stop_requested')=1
      AND json_extract(a.record,'$.facts.coordinator') IN ('cancelled','timed_out')))
);
