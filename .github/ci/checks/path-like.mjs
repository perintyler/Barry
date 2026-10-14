export function pathLike(token, rootEntries) {
  if (!/^[\w@./-]+$/.test(token)) return false; // letters/digits/._-/ only
  // .git/info/exclude exists in a normal checkout, but .git is a FILE in a
  // worktree — a reference to it passes in one and fails in the other, which
  // is checkout shape, not doc health.
  if (token.startsWith(".git/")) return false;
  if (!token.includes("/")) return false;
  if (token.includes("://") || token.startsWith("/")) return false;
  if (/[<>]|:\d/.test(token)) return false; // placeholders, file.ts:42
  if (/(^|\/)dist(\/|$)|\.generated$/.test(token)) return false; // built, not tracked
  // Root-anchored: the first segment has to be something the checkout has.
  // `github.com/owner/name` and `Features/Identities` are references to other
  // worlds, not to files here.
  if (!rootEntries.has(token.split("/")[0])) return false;
  return true;
}
