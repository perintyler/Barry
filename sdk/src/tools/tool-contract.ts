import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { version as zodVersion } from "zod/v4/core";
import { zodSchemaToJson } from "./zod-to-json.js";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Fingerprint the declared callable contract, not handler implementation. */
export function toolContractHash(tool: {
  namespace: string;
  name: string;
  access: "read" | "write";
  schema: unknown;
  outputSchema?: Record<string, unknown>;
}): string {
  const contract = {
    version: 1,
    namespace: tool.namespace,
    name: tool.name,
    access: tool.access,
    input: zodSchemaToJson(tool.schema, `${tool.namespace}:${tool.name}`),
    output: tool.outputSchema ?? null,
  };
  return createHash("sha256").update("barry-tool-contract.v1\0").update(stableJson(contract)).digest("hex");
}

let derivation: string | null | undefined;

/**
 * A fingerprint of how `toolContractHash` turns a tool into a hash: this
 * module's code, the schema conversion it calls, and the zod doing the
 * converting.
 *
 * A hash cached beside a bag's bundle is only valid for the code that
 * computed it, and that code changes without the bundle changing:
 * `fb25dfdb1` moved 411 hashes at once. Null when the code cannot be read,
 * which leaves nothing to cache against.
 */
export function contractDerivation(): string | null {
  if (derivation !== undefined) return derivation;
  try {
    const here = fileURLToPath(import.meta.url);
    const hash = createHash("sha256").update(`zod ${zodVersion.major}.${zodVersion.minor}.${zodVersion.patch}\0`);
    for (const name of ["tool-contract", "zod-to-json", "normalize-json-schema"]) {
      hash.update(readFileSync(join(dirname(here), `${name}${extname(here)}`)));
    }
    derivation = hash.digest("hex").slice(0, 16);
  } catch {
    derivation = null;
  }
  return derivation;
}
