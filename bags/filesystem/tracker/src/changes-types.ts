export interface Change {
  id: string;
  session_id: string;
  tool: string;
  file_path: string | null;
  old_content: string | null;
  new_content: string | null;
  created_at: string;
}

export interface ChangeStats {
  total_changes: number;
  changes_by_tool: { tool: string; count: number }[];
  changes_by_session: { session_id: string; count: number }[];
  most_modified_files: { file_path: string; count: number }[];
}
