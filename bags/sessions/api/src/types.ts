// Session with metadata fields flattened for backward compatibility
export interface Session {
  id: string;
  active: boolean;
  user_id: number | null;
  // Nullable since migration 033: the action executor, the CLI's one-shot
  // runner and the reaper create sessions with no actor to attribute to, and
  // now say so instead of writing an 'agent-default' sentinel.
  agent_token: string | null;
  created_at: string;
  ended_at: string | null;
  // Legacy fields stored in metadata
  working_directory: string | null;
  git_branch: string | null;
  git_remote: string | null;
  transcript_path: string | null;
  permission_mode: string | null;
  source: string | null;
  end_reason: string | null;
  hostname: string | null;
  user: string | null;
  name: string | null;
  web_enabled: boolean;
  provider: string | null;
  model: string | null;
  identity_id: number | null;
}

export interface TranscriptEntry {
  type: "user" | "assistant" | "tool_use" | "tool_result" | "system";
  content: string;
  timestamp?: string;
  tool_name?: string;
}
