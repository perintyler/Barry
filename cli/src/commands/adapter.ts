/**
 * `barry adapter list | check | add <path>`
 *
 * What is installed, whether it still holds up, and putting one in. `add`
 * records nothing that did not pass: a package whose declarations do not
 * hold up, or that this machine cannot run, is refused and left where it is
 * — a half-registered adapter that appears in `list` and fails at session
 * start is worse than one that never arrived.
 *
 * Barry installs from a path and never fetches: the user puts the package
 * where they want it with their own package manager, and Barry verifies and
 * records it.
 */
import { resolve } from "node:path";
import {
  modeVersions,
  AdapterNotInstalled,
  AdapterRefused,
  type Adapter,
  type Adapters,
  type InstalledAdapter,
} from "@barry-rocks/sdk/adapters/harnesses";
import { MODE_IDS } from "@barry-rocks/sdk/ids";

export interface AdapterCommandDeps {
  adapters: Adapters;
  write(line: string): void;
}

/** One recorded adapter as report lines. */
export function formatAdapter(record: InstalledAdapter, problems: readonly string[] = []): string[] {
  const declared = MODE_IDS.filter((id) => record.modes[id]);
  const verified = [...new Set(declared.map((id) => record.modes[id]?.verifiedOn))].join(", ");
  const platforms = [...new Set(declared.flatMap((id) => record.modes[id]?.platforms ?? []))];
  return [
    `${record.id}  (${record.label})`,
    `  path     ${record.path}  ${record.version}`,
    `  modes    ${declared.join(", ")}  default: ${record.defaultMode}`,
    `  verified ${verified}`,
    ...declared.map(id => {
      const policy = modeVersions(record.modes[id]!);
      return `  ${id}: recommended ${policy.recommendedVersion}; tested ${policy.testedVersions.join(", ")}; supported ${policy.supportedVersions.map(range => `${range.min ?? "*"}..${range.before ? `<${range.before}` : range.max ?? "*"}`).join(", ") || "not established"}`;
    }),
    ...(record.experimental ? [`  experimental ${record.experimental}`] : []),
    ...(platforms.length ? [`  platforms ${platforms.join(", ")}`] : []),
    ...problems.map((problem) => `  PROBLEM  ${problem}`),
  ];
}

async function problemsLoading(adapters: Adapters, id: string): Promise<string[]> {
  try {
    await adapters.load(id);
    return [];
  } catch (err) {
    if (err instanceof AdapterRefused) return err.problems;
    if (err instanceof AdapterNotInstalled) return [err.message];
    return [`does not load: ${err instanceof Error ? err.message : String(err)}`];
  }
}

/**
 * `barry adapter list`. Returns the number of adapters with problems, which
 * the caller uses as its exit code — "one broken" differs from "nothing works".
 */
export async function listAdapters(deps: AdapterCommandDeps): Promise<number> {
  const records = deps.adapters.installed();
  let broken = 0;

  for (const record of records) {
    const problems = await problemsLoading(deps.adapters, record.id);
    if (problems.length > 0) broken += 1;
    for (const line of formatAdapter(record, problems)) deps.write(line);
    deps.write("");
  }

  // Printed even at zero, so an empty install does not read as a broken command.
  deps.write(
    records.length === 0
      ? "No adapters installed. `barry adapter add <path>` to add one; `barry adapter doctor` says what each needs."
      : `${records.length} adapter(s) installed, ${broken} with problems.`,
  );
  return broken;
}

/** `barry adapter check [id]`: load each and check its declarations again. */
export async function checkAdapters(deps: AdapterCommandDeps, only?: string): Promise<number> {
  const ids = deps.adapters
    .installed()
    .map((record) => record.id)
    .filter((id) => !only || id === only);
  if (only && ids.length === 0) {
    deps.write(`no adapter named ${only}`);
    return 1;
  }
  let failed = 0;
  for (const id of ids) {
    const problems = await problemsLoading(deps.adapters, id);
    deps.write(problems.length === 0 ? `ok    ${id}` : `FAIL  ${id}`);
    for (const problem of problems) deps.write(`      ${problem}`);
    if (problems.length > 0) failed += 1;
  }
  deps.write(`${ids.length} checked, ${failed} failed.`);
  return failed;
}

/**
 * `barry adapter add <path>`. `vet` is doctor's verdict on this machine, asked
 * only after the adapter's own declarations pass — a missing binary is the
 * user's to fix, and saying so is more useful once the adapter is cleared.
 */
export async function addAdapter(
  deps: AdapterCommandDeps & { vet: (adapter: Adapter) => Promise<string[]> },
  path: string,
): Promise<number> {
  try {
    const record = await deps.adapters.add(resolve(path), { vet: deps.vet });
    deps.write(`Added ${record.id} (${record.label}) from ${record.path}.`);
    return 0;
  } catch (err) {
    const problems = err instanceof AdapterRefused ? err.problems : [err instanceof Error ? err.message : String(err)];
    deps.write(`Refused to add ${path}:`);
    for (const problem of problems) deps.write(`  ${problem}`);
    deps.write("Nothing was recorded. The package is still where it was.");
    return 1;
  }
}

export function removeAdapter(deps: AdapterCommandDeps, id: string): number {
  if (!deps.adapters.remove(id)) { deps.write(`No adapter selected as ${id}.`); return 1; }
  deps.write(`Removed selection ${id}; package files and registered bag data are preserved.`);
  return 0;
}


export interface ModelAdapterCommandDeps {
  providers: import("@barry-rocks/sdk/adapters/models").ModelVendors;
  shipped: readonly { packageName: string }[];
  write(line: string): void;
  error?(line: string): void;
}

function modelProviderHint(deps: ModelAdapterCommandDeps, name: string): string {
  if (deps.providers.installed().some(record => record.packageName === name && record.shipped)) return "run pnpm build:packages, then barry setup";
  return deps.shipped.some(record => record.packageName === name)
    ? `run barry adapter model remove ${name}, then barry setup`
    : `run barry adapter model remove ${name}`;
}

/** Model diagnostics load code so unavailable records are visible before a call fails. */
export async function modelAdapterCommand(
  deps: ModelAdapterCommandDeps,
  action: "list" | "add" | "remove" | "check",
  argument?: string,
): Promise<number> {
  const errorLine = (line: string) => {
    if (deps.error) deps.error(line);
    else deps.write(line);
  };
  try {
    if (action === "add") {
      const record = await deps.providers.add(argument!);
      deps.write(`Selected ${record.packageName} from ${record.path}.`);
      return 0;
    }
    if (action === "remove") {
      if (!deps.providers.remove(argument!)) {
        errorLine(`${argument} is not selected; run barry adapter model list.`);
        return 1;
      }
      deps.write(`Removed selection ${argument}.`);
      return 0;
    }
    await deps.providers.load(action === "check" && argument ? [argument] : undefined);
    if (action === "list") {
      const records = deps.providers.installed();
      for (const record of records) deps.write(`${record.packageName}  ${record.version}  ${record.path}`);
      if (!records.length) deps.write("No model providers selected. Run barry setup, or barry adapter model add <package-directory>.");
    }
    for (const [name, problems] of deps.providers.refused) {
      errorLine(`Refused ${name}: ${problems.join("; ").replace(/\s+/g, " ")}; ${modelProviderHint(deps, name)}.`);
    }
    if (action === "check" && !deps.providers.refused.size) deps.write("Selected model provider contracts passed.");
    return deps.providers.refused.size;
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ");
    const hint = action === "add"
      ? "build or reinstall the package, then barry adapter model add <package-directory>"
      : "run barry adapter model list";
    errorLine(`Refused to ${action} model adapter: ${message}; ${hint}.`);
    return 1;
  }
}
