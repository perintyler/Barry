import type { TokenType } from "../types.js";

export interface TokenRule {
  type: TokenType;
  /** Must have the sticky (y) flag set. */
  pattern: RegExp;
}

export interface LanguageTokenizer {
  name: string;
  /** Aliases this tokenizer should respond to (e.g. ["js", "jsx"] for javascript). */
  aliases: string[];
  rules: TokenRule[];
}
