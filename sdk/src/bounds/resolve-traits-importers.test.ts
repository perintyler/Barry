import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

it("keeps the documented production resolveTraits importer set accurate", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const paths = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0");
  const consumers = paths.filter(path => /\.(?:m?ts|tsx)$/.test(path) && !/\.(?:test|spec)\.[^.]+$/.test(path) && !path.endsWith(".d.ts")).filter(path => {
    const file = ts.createSourceFile(path, readFileSync(join(root, path), "utf8"), ts.ScriptTarget.Latest, true);
    return file.statements.some(statement => ts.isImportDeclaration(statement)
      && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
      && statement.importClause.namedBindings.elements.some(binding => (binding.propertyName ?? binding.name).text === "resolveTraits"));
  }).sort();
  expect(consumers).toEqual(["sdk/src/bounds/filter-tools.ts", "sdk/src/traits/index.ts"]);
  const docs = readFileSync(join(root, "sdk/docs/bounds.md"), "utf8");
  for (const consumer of consumers) expect(docs).toContain(consumer);
});
