export type TokenType =
  | "keyword"
  | "string"
  | "comment"
  | "number"
  | "function"
  | "type"
  | "operator"
  | "variable"
  | "tag"
  | "attribute"
  | "meta"
  | "regexp"
  | "literal"
  | "punctuation"
  | "decorator"
  | "property";

export type Confidence = "high" | "medium" | "low";

export interface DetectResult {
  language: string;
  confidence: Confidence;
}
