import { loadBagToolDefinitions } from "../tool-definitions.js";
import { parseManifest } from "../manifest.js";
/**
 * Check granted namespaces against actual shipped tool modules, not bag-name assumptions; external checkouts are outside this fixture’s scope.
 * See docs/decisions/0011-sdk-runtime-invariants.md for the retained rationale.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { discoverBuiltinBags } from "../builtin.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const BUILTIN_DIR = join(REPO_ROOT, "bags");
/** The builtin bags — the ones whose source we can actually read. */
function inRepoLocalBags(): Array<{ name: string; dir: string }> {
  return Object.entries(discoverBuiltinBags(BUILTIN_DIR).local).map(([name, rel]) => ({
    name,
    dir: join(BUILTIN_DIR, rel),
  }));
}

/**
 * Namespaces the bag's TOOL SOURCE stamps, read from the code rather than the
 * manifest.
 *
 * A regex over `defineTool({ namespace: "x" })` rather than a dynamic import:
 * the built bundle lives in a purgeable cache that CI never populates
 * (`barry bag build` is not a CI step), and importing raw TypeScript drags in
 * each bag's whole dependency graph. The namespace is always a string literal
 * on the tool definition, so reading it is exact — and unlike an import it
 * cannot fail for reasons unrelated to namespaces.
 *
 * Returns null when there is no tool source to read, which is NOT the same as
 * "no namespaces" — see the unreadable handling in the tests.
 */
function namespacesStampedInSource(dir: string): Set<string> | null {
  const roots = [join(dir, "src"), dir];
  const files: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      if (!/^tools?\.ts$|^tools\.tsx$/.test(entry)) continue;
      const full = join(root, entry);
      if (statSync(full).isFile()) files.push(full);
    }
    // A bag may split tools across src/tools/*.ts
    const toolsDir = join(root, "tools");
    if (existsSync(toolsDir) && statSync(toolsDir).isDirectory()) {
      for (const entry of readdirSync(toolsDir)) {
        if (entry.endsWith(".ts")) files.push(join(toolsDir, entry));
      }
    }
  }
  if (files.length === 0) return null;

  const found = new Set<string>();
  for (const file of files) {
    const text = readFileSync(file, "utf-8");
    // Match `namespace: "x"` specifically on `defineTool(...)` definitions,
    // avoiding false positives from authorization checks like `assertToolAllowed(..., { namespace: "stores" })`.
    for (const m of text.matchAll(/(?:Barry\.Tool|defineTool)\s*\(\s*\{[^}]*?namespace:\s*["'`]([^"'`]+)["'`]/gs)) {
      found.add(m[1]);
    }
    // Also match when namespace is first property:
    // defineTool({ namespace: "x"
    // or when const NAMESPACE is defined
    for (const m of text.matchAll(/const\s+NAMESPACE\s*=\s*["'`]([^"'`]+)["'`]/g)) {
      if (/(?:Barry\.Tool|defineTool)\s*\(\s*\{[^}]*?namespace:\s*NAMESPACE/s.test(text)) found.add(m[1]);
    }
  }
  return found;
}

/** Namespaces a bag DECLARES — manifest tool-metadata plus mcp-servers keys. */
async function declaredNamespaces(dir: string): Promise<Set<string>> {
  const manifestPath = join(dir, "bag.yaml");
  const declared = new Set<string>();
  if (!existsSync(manifestPath)) return declared;
  const manifest = parseYaml(readFileSync(manifestPath, "utf-8")) ?? {};
  for (const t of manifest["tool-metadata"] ?? []) {
    if (t?.namespace) declared.add(t.namespace);
  }
  if (Array.isArray(manifest.tools)) {
    for (const t of manifest.tools) if (t?.namespace) declared.add(t.namespace);
  }
  for (const key of Object.keys(manifest["mcp-servers"] ?? {})) declared.add(key);
  const parsed = parseManifest(dir);
  if (parsed) {
    const definitions = await loadBagToolDefinitions({ name: parsed.name, source: { type: "local", path: dir }, manifest: parsed });
    for (const tool of definitions ?? []) declared.add(tool.namespace);
  }
  return declared;
}

describe("shipped bags declare the namespaces their tools carry", () => {
  it("every shipped extension stamps exactly its parent's namespace", async () => {
    let extensions = 0;
    for (const { dir } of inRepoLocalBags()) {
      const manifest = parseManifest(dir);
      if (!manifest?.extends) continue;
      extensions++;
      const tools = await loadBagToolDefinitions({ name: `${manifest.extends}/${manifest.name}`, source: { type: "local", path: dir }, manifest });
      expect(tools?.length).toBeGreaterThan(0);
      expect(new Set(tools?.map((tool) => tool.namespace))).toEqual(new Set([manifest.extends]));
    }
    expect(extensions).toBeGreaterThan(0);
  });

  it("serves search_messages from the registered sessions/search extension in the sessions namespace", async () => {
    const search = inRepoLocalBags().find((bag) => bag.name === "sessions/search");
    expect(search, "sessions/search is not a registered builtin").toBeDefined();
    const tools = await loadBagToolDefinitions({ name: search!.name, source: { type: "local", path: search!.dir }, manifest: parseManifest(search!.dir) });
    expect(tools?.find((tool) => tool.name === "search_messages")).toMatchObject({ namespace: "sessions" });
  });

  it("every namespace in tool source is exported by its module", async () => {
    const bags = inRepoLocalBags();

    // Anti-tautology guard. If the registry stops resolving, every loop below
    // iterates nothing and this file reports a triumphant pass. Refuse to.
    expect(
      bags.length,
      "no in-repo local bags resolved — this test cannot fail and is not verifying anything",
    ).toBeGreaterThan(5);

    const drifted: string[] = [];
    let inspected = 0;

    for (const { name, dir } of bags) {
      const stamped = namespacesStampedInSource(dir);
      if (stamped === null || stamped.size === 0) continue; // no in-process tools
      inspected++;
      const declared = await declaredNamespaces(dir);
      for (const ns of stamped) {
        if (declared.has(ns)) continue;
        // Undeclared is fine when the namespace IS the bag name — that is
        // exactly what the auto-traits fallback guesses, and it guesses right.
        // Undeclared AND different is the bug: the fallback then invents a
        // namespace no tool carries, and grants it while the real one goes
        // ungranted. That is how `sessions` (tools on `session`) shipped a
        // hollow grant inside DEFAULT_TRAITS.
        if (ns === name) continue;
        drifted.push(
          `${name}: tools stamp "${ns}" but the manifest declares ` +
            `{${[...declared].join(", ") || "nothing"}} — the fallback will invent "${name}"`,
        );
      }
    }

    // Second guard: bags resolved, but none had readable tool source.
    expect(
      inspected,
      "no bag's tool source was readable — the namespace comparison never ran",
    ).toBeGreaterThan(3);

    expect(
      drifted,
      "bags whose tools stamp a namespace that is neither declared nor the bag name.\n" +
        "The bag-name fallback invents a namespace no tool carries — add a\n" +
        "`tool-metadata:` block naming the real one (see bags/sessions, bags/clickhouse):\n  " +
        drifted.join("\n  "),
    ).toEqual([]);
  });

  it("every namespace a shipped bag's trait grants is carried by a real tool or a declared server", async () => {
    const carried = new Set<string>();

    // 1. What in-repo bags' tools actually stamp, read from source — NOT the
    //    bag name. This is the whole point: `sessions` contributes `session`
    //    here, so a trait granting `sessions` has nothing carrying it.
    for (const { name, dir } of inRepoLocalBags()) {
      const stamped = namespacesStampedInSource(dir);
      for (const ns of stamped ?? []) carried.add(ns);
      // A declared MCP server is genuinely provided by the vendor, not by code.
      for (const ns of await declaredNamespaces(dir)) carried.add(ns);
      // A bag with no readable in-process tools (skills-only, app-only, or tools
      // behind a shape this cannot parse) keeps the benefit of the doubt: the
      // fallback would grant its name, and we have no evidence to contradict
      // that. Only a bag whose source we DID read can convict its own grant.
      if (stamped === null || stamped.size === 0) carried.add(name);
    }

    expect(
      carried.size,
      "no namespaces collected — the loader found nothing and this test cannot fail",
    ).toBeGreaterThan(5);

    // Barry ships no traits of its own; every trait is a bag's.
    const traits = Object.values(discoverBuiltinBags(BUILTIN_DIR).local).flatMap((rel) =>
      Object.entries(parseManifest(join(BUILTIN_DIR, rel))?.traits ?? {}),
    );
    expect(traits.length, "no shipped bag declares a trait").toBeGreaterThan(0);

    /**
     * Stale names a trait keeps DELIBERATELY, beside the real one.
     *
     * Traits are additive, so dropping a name a live session may still hold
     * could take its tools away mid-flight; the safe migration is to grant both
     * for one release and remove the stale one once no trait row references it.
     * An entry here is a promise that the real namespace is granted too — which
     * the assertion below enforces, so this cannot be used to silence a grant
     * that resolves to nothing.
     */
    const TRANSITIONAL_ALIASES: Record<string, string> = {
      // bags/sessions declares `session`; `sessions` is the pre-fix bag-name guess.
      sessions: "session",
    };

    const uncarried: string[] = [];
    for (const [traitName, trait] of traits) {
      const granted = trait.bags;
      for (const ns of granted) {
        if (carried.has(ns)) continue;
        const real = TRANSITIONAL_ALIASES[ns];
        if (real && granted.includes(real) && carried.has(real)) continue;
        uncarried.push(
          real
            ? `${traitName} → ${ns} (stale alias, and its real namespace "${real}" is NOT granted alongside it)`
            : `${traitName} → ${ns}`,
        );
      }
    }

    expect(
      uncarried,
      "shipped bags' traits granting namespaces no real tool carries:\n  " +
        uncarried.join("\n  ") +
        "\n(a grant nothing provides resolves to zero tools, silently)",
    ).toEqual([]);
  });
});
