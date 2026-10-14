// Adapted from the pinned barry-devops checks for the single SDK package.
/**
 * Detects a hand-built home-relative Barry path in a source file: a string
 * naming Barry state or configuration directories, or the macOS
 * `Library/{Application Support,Caches,Logs}/Barry` directories, within a few
 * lines of `homedir()` / `process.env.HOME` / `$HOME`.
 *
 * Such a path ignores BARRY_HOME, so code using it writes the real
 * installation's state from inside a contributor or test instance. Used by
 * `check:barry-home`.
 */
export const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
export const TEST = /(\.test\.|\.spec\.|\/test\/|\/tests\/|\/__tests__\/|\.d\.ts$)/;
const BARRY_PATH = /["'`/]\.barry\b|["'`](Application Support|Caches|Logs)["'`]\s*,\s*["'`][Bb]arry["'`]|Library\/(Application Support|Caches|Logs)\/[Bb]arry|["'`]\.config["'`]\s*\)?\s*,\s*["'`]barry["'`]|\.config\/barry\b/;
const HOME_REF = /homedir\(|process\.env\.HOME\b|\$HOME\b|env\.HOME\b/;
const COMMENT = /^\s*(\*|\/\/|\/\*)/;
const WINDOW = 3;

/** Each hand-built home path in `text`: its 1-based line, the line, and the lines around it. */
export function handBuiltHomePaths(text) {
  const lines = text.split("\n");
  const out = [];
  lines.forEach((line, i) => {
    if (COMMENT.test(line) || !BARRY_PATH.test(line)) return;
    const window = lines.slice(Math.max(0, i - WINDOW), i + 2).filter((l) => !COMMENT.test(l)).join("\n");
    if (HOME_REF.test(window)) out.push({ line: i + 1, text: line.trim(), window });
  });
  return out;
}
