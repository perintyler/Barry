import { definePrompt } from "@barry-rocks/sdk/tools";
import { resolveMemoryPrompt } from "./injection.js";

/**
 * Memories for the session's scope. `cwd` rather than `repo`: each composition
 * root already resolves the scope directory (the API falls back to $HOME for a
 * repo-less session so it sees only global memories), and `repo` can be "".
 */
export default definePrompt(({ cwd }) => {
  const prompt = resolveMemoryPrompt(cwd);
  return prompt ? [{ text: prompt }] : [];
});
