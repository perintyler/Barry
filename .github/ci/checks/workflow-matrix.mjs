export const REQUIRED_TEST_INPUTS = ["sdk/**", "cli/**", "bags/**", "adapters/**", "vitest.base.config.ts", "vitest.instance-home.setup.ts", ".github/ci/**", ".github/actions/setup/action.yml", "package.json", "workspace-entries.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "vitest.config.ts", "tsconfig*.json", ".github/workflows/test.yml", ".github/workflows/_unit-tests.yml"];

export function matrixProblems(document, workspaceKeys) {
  const problems = [];
  const inputs = document.on?.push?.paths ?? [];
  for (const input of REQUIRED_TEST_INPUTS) if (!inputs.includes(input)) problems.push(`test.yml: missing shared trigger ${input}`);
  const job = document.jobs?.workspace;
  if (job?.uses !== "./.github/workflows/_unit-tests.yml" || job.with?.command !== "node .github/ci/run.mjs test:ci:unit --scope=${{ matrix.scope }}") problems.push("test.yml: matrix scope must select the reusable unit runner");
  if (job?.secrets) problems.push("test.yml: the vendored runner needs no inherited repository secrets");
  const scopes = job?.strategy?.matrix?.scope;
  if (!Array.isArray(scopes) || scopes.some(scope => typeof scope !== "string")) return [...problems, "test.yml: declare literal matrix scopes"];
  const selected = scopes.flatMap(scope => scope.split(","));
  for (const scope of selected) if (!workspaceKeys.some(key => key === scope || key.startsWith(`${scope}/`))) problems.push(`test.yml: scope ${scope} selects no workspace`);
  for (const key of workspaceKeys) if (!selected.some(scope => key === scope || key.startsWith(`${scope}/`))) problems.push(`test.yml: no matrix scope selects ${key}`);
  return problems;
}
