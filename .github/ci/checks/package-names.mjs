/** Workspace package names follow their path and composition role. */
export function packageNameFor(directory) {
  if (directory === "sdk" || directory === "cli") return `@barry-rocks/${directory}`;
  const parts = directory.split("/");
  if (parts[0] === "adapters" && parts.length === 3 && ["sessions", "completions", "decisions", "embeddings"].includes(parts[1])) {
    return `@barry-rocks/${parts[1].slice(0, -1)}-${parts[2]}`;
  }
  if (parts[0] !== "bags" || parts.length < 2) throw new Error(`Unknown workspace role: ${directory}`);
  const leaf = parts.at(-1);
  if (parts.length === 3 && ["server", "api", "runtime"].includes(leaf)) {
    return `@barry-rocks/${parts[1]}-${leaf === "server" ? "service" : leaf}`;
  }
  if (parts.length === 3 && leaf === "scheduler") return "@barry-rocks/scheduler-service";
  return `@barry-rocks/${leaf}-bag`;
}

export function packageNameProblems(packages) {
  const problems = [];
  const owners = new Map();
  for (const [directory, manifest] of Object.entries(packages)) {
    const expected = packageNameFor(directory);
    if (manifest.name !== expected) problems.push(`${directory}: expected ${expected}, found ${manifest.name}`);
    if (owners.has(expected)) problems.push(`${directory}: canonical name ${expected} collides with ${owners.get(expected)}`);
    owners.set(expected, directory);
    if (manifest.private && manifest.version !== "0.0.0") problems.push(`${directory}: private workspace version must be 0.0.0`);
  }
  return problems;
}
