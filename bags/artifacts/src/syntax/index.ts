export { highlight } from "./highlight.js";
export { detect } from "./detect.js";
export { languageFromExt } from "./extensions.js";
export { registerLanguage, getLanguage, listLanguages } from "./languages/index.js";

export type { DetectResult, Confidence, TokenType } from "./types.js";
export type { LanguageTokenizer, TokenRule } from "./languages/types.js";
