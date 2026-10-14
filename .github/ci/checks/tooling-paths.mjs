import path from "node:path";

/** Check concrete source prefixes; runtime ignore patterns are not source declarations. */
export function toolingPathProblems(file, values, exists) {
  const problems = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const prefix = value.replace(/^!/, "").replace(/^\//, "").split(/[?*[]/)[0].replace(/\/$/, "");
    if (!prefix || !prefix.includes("/") && value.startsWith("!")) continue;
    const resolved = file === ".gitignore" ? prefix : path.posix.normalize(path.posix.join(path.posix.dirname(file), prefix));
    if (!exists(resolved)) problems.push(`${file}: source prefix ${resolved} matches no tracked path`);
  }
  return problems;
}
