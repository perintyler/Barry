/** Context supplied to a bag's computed prompt entry. */
export interface PromptContext {
  cwd: string;
  repo?: string;
  sessionId?: string;
  provider?: string;
}

/** One complete section contributed to the system prompt. */
export interface PromptSection {
  text: string;
}

export type PromptContributor = (context: PromptContext) =>
  | PromptSection[]
  | Promise<PromptSection[]>;

/** Mark a function as a bag prompt entry and retain its inferred type. */
export function definePrompt<T extends PromptContributor>(contributor: T): T {
  return contributor;
}
