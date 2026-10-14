export const mirrorGuard = "github.repository != 'perintyler/barry-dev' && github.event.repository.private == false";

/** The development repository never allocates an Actions runner. */
export function hasMirrorGuard(condition) {
  if (condition === mirrorGuard) return true;
  if (typeof condition !== "string" || !condition.startsWith(`${mirrorGuard} && (`) || !condition.endsWith(")")) return false;
  const suffix = condition.slice(`${mirrorGuard} && `.length);
  let depth = 0, quote;
  for (let index = 0; index < suffix.length; index++) {
    const character = suffix[index];
    if (quote) { if (character === quote) quote = undefined; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === "(") depth++;
    if (character === ")") depth--;
    if (depth === 0 && index !== suffix.length - 1 || depth < 0) return false;
  }
  return depth === 0 && quote === undefined;
}
