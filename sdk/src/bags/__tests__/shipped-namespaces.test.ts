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
  it("every shipped bag declaring implements exports the tools it claims to implement", async () => {
    let implementers = 0;
    for (const { dir } of inRepoLocalBags()) {
      const manifest = parseManifest(dir);
      if (!manifest?.implements?.tools.length) continue;
      implementers++;
      const tools = await loadBagToolDefinitions({ name: manifest.name, source: { type: "local", path: dir }, manifest });
      expect(tools?.length).toBeGreaterThan(0);
      const exportedIds = new Set(tools?.map((tool) => `${tool.namespace}:${tool.name}`));
      for (const claimed of manifest.implements.tools) {
        expect(exportedIds).toContain(claimed);
      }
    }
    expect(implementers).toBeGreaterThan(0);
  });

  it("serves search_messages from the registered session-vector-search bag in the sessions namespace", async () => {
    const search = inRepoLocalBags().find((bag) => bag.name === "session-vector-search");
    expect(search, "session-vector-search is not a registered builtin").toBeDefined();
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

  it("every namespace a shipped bag declares in tool-metadata or mcp-servers is carried by a real tool or server", async () => {
    const carried = new Set<string>();
    const declaredByBag: Array<{ bag: string; namespaces: string[] }> = [];

    for (const { name, dir } of inRepoLocalBags()) {
      const stamped = namespacesStampedInSource(dir);
      for (const ns of stamped ?? []) carried.add(ns);
      const declared = await declaredNamespaces(dir);
      for (const ns of declared) carried.add(ns);
      if (stamped === null || stamped.size === 0) carried.add(name);
      if (declared.size > 0) {
        declaredByBag.push({ bag: name, namespaces: [...declared] });
      }
    }

    expect(
      carried.size,
      "no namespaces collected — the loader found nothing and this test cannot fail",
    ).toBeGreaterThan(5);
    expect(declaredByBag.length, "no shipped bag declares tool namespaces").toBeGreaterThan(0);

    const uncarried: string[] = [];
    for (const { bag, namespaces } of declaredByBag) {
      for (const ns of namespaces) {
        if (!carried.has(ns)) {
          uncarried.push(`${bag} → ${ns}`);
        }
      }
    }

    expect(uncarried).toEqual([]);
  });
});
