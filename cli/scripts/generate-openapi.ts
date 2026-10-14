import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// Imports can open stores, so isolate the process before loading either app.
process.env.BARRY_HOME = mkdtempSync(resolve(tmpdir(), "barry-openapi-"));
for (const key of Object.keys(process.env)) {
  if (key.startsWith("BARRY_") && key.endsWith("_DB")) delete process.env[key];
}
const [{ sessionsApi }, { identitiesApi }, { apiRoutes, openApiDocument }] = await Promise.all([
  import("@barry-rocks/sessions-api/app"),
  import("@barry-rocks/identities-service/app"),
  import("@barry-rocks/sdk/internal/routes"),
]);

const roots = [sessionsApi(), identitiesApi()];
const { servicesRouter } = await import("@barry-rocks/mcp-bag");
const { servedRoutes } = await import("@barry-rocks/sdk/services/http");
const routes = [...roots.flatMap(root => root.routes), ...servedRoutes(servicesRouter())];
const declarations = new Set(apiRoutes);
const served = new Set(routes);
for (const declaration of routes) {
  if (!declarations.has(declaration)) throw new Error(`Undeclared served route: ${declaration.operationId}`);
}
for (const declaration of apiRoutes) {
  if (!served.has(declaration)) throw new Error(`Unserved declaration: ${declaration.operationId}`);
}
const document = openApiDocument(routes);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const outputPath = resolve(repoRoot, "sdk/openapi.json");
const barryKitDir = process.env.BARRY_KIT_DIR;
const barryKitPresent = barryKitDir !== undefined && existsSync(barryKitDir);
const output = `${JSON.stringify(document, null, 2)}\n`;

function swiftCompatibleOpenApi(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(swiftCompatibleOpenApi);
  if (!value || typeof value !== "object") return value;

  const input = value as Record<string, unknown>;
  const anyOf = input.anyOf;
  if (Array.isArray(anyOf) && anyOf.length === 2) {
    const nonNull = anyOf.find((item) => !(item && typeof item === "object" && (item as Record<string, unknown>).type === "null"));
    const hasNull = anyOf.some((item) => item && typeof item === "object" && (item as Record<string, unknown>).type === "null");
    if (hasNull && nonNull) {
      return { ...(swiftCompatibleOpenApi(nonNull) as Record<string, unknown>), nullable: true };
    }
  }

  const converted = Object.fromEntries(
    Object.entries(input)
      .filter(([key]) => key !== "$schema")
      .map(([key, child]) => [key, swiftCompatibleOpenApi(child)]),
  );
  // OpenAPI 3.0 uses a boolean flag beside minimum/maximum; 3.1 carries
  // the exclusive bound itself. Preserve the constraint for Swift's parser.
  for (const [exclusive, inclusive] of [["exclusiveMinimum", "minimum"], ["exclusiveMaximum", "maximum"]]) {
    if (typeof input[exclusive] === "number") {
      converted[inclusive!] = input[exclusive];
      converted[exclusive!] = true;
    }
  }
  if ("const" in input) { converted.enum = [input.const]; delete converted.const; }
  return converted;
}

const swiftDocument = swiftCompatibleOpenApi(document) as Record<string, unknown>;
swiftDocument.openapi = "3.0.3";
const outputs = new Map([[outputPath, output]]);
if (barryKitPresent) outputs.set(resolve(barryKitDir, "Sources/openapi.yaml"), `${JSON.stringify(swiftDocument, null, 2)}\n`);

if (process.argv.includes("--check")) {
  for (const [path, expected] of outputs) {
    if (readFileSync(path, "utf8") !== expected) {
      console.error(`Generated OpenAPI is stale: ${path}. Run: pnpm contracts:generate`);
      process.exit(1);
    }
  }
  console.log(`OpenAPI in sync (${outputs.size} targets compared):`);
  for (const path of outputs.keys()) console.log(`  ${path}`);
} else {
  for (const [path, generated] of outputs) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, generated);
  }
  console.log(`Wrote ${outputs.size} OpenAPI targets`);
}
if (!barryKitPresent) console.log(`SKIPPED the Swift spec: ${barryKitDir === undefined ? "BARRY_KIT_DIR is not set" : `no BarryKit at ${barryKitDir}`}`);
