-- Drop the uniqueness guard. The deleted duplicate rows are NOT restored:
-- they were unreferenced copies carrying randomly generated tokens, so
-- recreating them would produce different tokens and no useful state.
DROP INDEX IF EXISTS actors_agent_name_key;
