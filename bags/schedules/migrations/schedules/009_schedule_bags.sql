UPDATE runtime_schedules
SET spec = json_remove(json_set(spec, '$.bags', json_extract(spec, '$.traits')), '$.traits')
WHERE json_valid(spec)
  AND json_extract(spec, '$.traits') IS NOT NULL
  AND json_extract(spec, '$.bags') IS NULL;
