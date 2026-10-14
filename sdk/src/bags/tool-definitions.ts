import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bagBuildExternals } from "./build-configuration.js";
import { ensureToolsBuilt } from "./build.js";
import type { Bag, BagToolMeta } from "./types.js";
import { toolDefinitions } from "../tools/definitions.js";
import { contractDerivation, toolContractHash } from "../tools/tool-contract.js";

type ToolsBag = Pick<Bag, "name" | "source" | "manifest">;

export async function loadBagToolDefinitions(bag: ToolsBag) {
  const entry = await toolsEntry(bag);
  return entry ? importToolDefinitions(bag, entry.path, entry.built ? stampOf(entry.path) : null) : undefined;
}

// Cache tool metadata by both bundle and contract-derivation stamps; source-only bags still import on each read.
// Rationale: docs/decisions/0009-runtime-and-fixture-invariants.md#note-010
export async function loadBagToolSummaries(bag: ToolsBag): Promise<BagToolMeta[] | undefined> {
  const entry = await toolsEntry(bag);
  if (!entry) return undefined;
  const summaryFile = entry.built ? entry.path.replace(/\.js$/, ".summary.json") : null;
  const stamp = summaryFile ? stampOf(entry.path) : null;
  if (summaryFile && stamp) {
    const cached = readSummary(summaryFile);
    if (cached?.stamp === stamp) return cached.tools;
  }
  const tools = (await importToolDefinitions(bag, entry.path, stamp)).map((tool): BagToolMeta => ({
    toolName: tool.name,
    namespace: tool.namespace,
    access: tool.access === "read" ? "read" : "readwrite",
    contractHash: toolContractHash(tool),
    ...(tool.description ? { description: tool.description } : {}),
  }));
  // Rebuilt while it was being read: the tools may belong to either bundle.
  if (summaryFile && stamp && stampOf(entry.path) === stamp) {
    // A cache: failing to write it costs the next launch an import, nothing more.
    try {
      writeFileSync(summaryFile, JSON.stringify({ version: SUMMARY_VERSION, stamp, tools }));
    } catch {
      // The summary is only a cache: the next read imports the bundle again.
    }
  }
  return tools;
}

/** Bump when the summary's shape or derivation changes, so old ones stop matching. */
const SUMMARY_VERSION = 3;

/** Where a bag's tools load from: its built bundle, or its source when builds are off. */
async function toolsEntry(bag: ToolsBag): Promise<{ path: string; built: boolean } | undefined> {
  if (bag.source.type !== "local" || !bag.manifest?.toolsEntry) return undefined;
  const root = bag.source.path.replace(/^~/, homedir());
  const source = join(root, bag.manifest.toolsEntry.entry);
  const built = process.env.BARRY_BAGS_BUILT !== "0";
  const path = built
    ? await ensureToolsBuilt({ name: bag.name, bagDir: root, entry: source, externals: bagBuildExternals(root) })
    : source;
  if (!existsSync(path)) throw new Error(`${bag.name}: tool entry is missing: ${path}`);
  return { path, built };
}

/**
 * Import a bag's tools, as of the bundle `stamp` names.
 *
 * ESM caches a module by URL for the life of the process. A service that
 * imported a bundle and then saw it rebuilt got the old module back from the
 * same URL, and wrote the old tool list into a summary stamped with the new
 * bundle: after `decisions.ask` became `decisions.make`, every summary reader
 * still saw `ask`. Keyed by stamp, a rebuilt bundle is a new module.
 */
async function importToolDefinitions(bag: ToolsBag, entry: string, stamp: string | null) {
  const url = pathToFileURL(entry);
  if (stamp) url.searchParams.set("bundle", stamp);
  try { return toolDefinitions(await import(url.href)); }
  catch (cause) { throw new Error(`${bag.name}: tool definitions could not be loaded`, { cause }); }
}

/** The summary version, contract derivation and bundle `mtimeMs:size`, or null when one cannot be read. */
function stampOf(path: string): string | null {
  const derivation = contractDerivation();
  if (!derivation) return null;
  try {
    const stat = statSync(path);
    return `${SUMMARY_VERSION}:${derivation}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

function readSummary(path: string): { stamp: string; tools: BagToolMeta[] } | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { stamp?: unknown; tools?: unknown };
    if (typeof parsed.stamp !== "string" || !Array.isArray(parsed.tools)) return null;
    return { stamp: parsed.stamp, tools: parsed.tools as BagToolMeta[] };
  } catch {
    return null;
  }
}
