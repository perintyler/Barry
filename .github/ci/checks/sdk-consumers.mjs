import ts from "typescript";
import { readFileSync, existsSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
const root = process.cwd();
const sdk = JSON.parse(readFileSync(join(root, "sdk/package.json"), "utf8"));
const entries = JSON.parse(
  readFileSync(join(root, "workspace-entries.json"), "utf8"),
);
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
)
  .split("\n")
  .filter((file) => file && existsSync(file));
const resolvedExports = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `const manifest = JSON.parse(process.argv[1]); console.log(JSON.stringify(Object.fromEntries(Object.keys(manifest.exports).map(key => [key, import.meta.resolve(manifest.name + key.slice(1))]))));`, JSON.stringify(sdk)], { cwd: join(root, "sdk"), encoding: "utf8" }));
const errors = [];
let exportsChecked = 0,
  consumers = new Set();
for (const [subpath, target] of Object.entries(sdk.exports)) {
  const targets = typeof target === "string" ? [target] : [target?.types, target?.import];
  if (targets.some(value => typeof value !== "string" || !existsSync(resolve(root, "sdk", value)))) {
    errors.push(`missing export ${subpath}: ${JSON.stringify(target)}`);
    continue;
  }
  exportsChecked++;
  try {
    const resolved = resolvedExports[subpath];
    if (!existsSync(new URL(resolved))) throw new Error("resolved export is missing");
  } catch (error) {
    errors.push(`unresolvable SDK export ${subpath}: ${error.message}`);
  }
}
for (const file of files.filter((file) => /\.(?:[mc]?[jt]sx?)$/.test(file))) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const visit = (node) => {
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      specifier = node.moduleSpecifier;
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      specifier = node.argument.literal;
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require") ||
        (ts.isPropertyAccessExpression(node.expression) &&
          ["resolve", "mock", "doMock", "importActual"].includes(node.expression.name.text)))
    )
      specifier = node.arguments[0];
    if (
      specifier &&
      ts.isStringLiteralLike(specifier) &&
      /^@barry-rocks\/sdk(?:\/|$)/.test(specifier.text)
    ) {
      const name = specifier.text,
        subpath =
          name === "@barry-rocks/sdk"
            ? "."
            : `.${name.slice("@barry-rocks/sdk".length)}`;
      if (file.startsWith("adapters/") && name.startsWith("@barry-rocks/sdk/internal/"))
        errors.push(`${file}: adapters must use stable SDK entries (${name})`);
      if (file.startsWith("sdk/src/") && file !== "sdk/src/imports.test.ts")
        errors.push(`${file}: SDK source must use relative imports (${name})`);
      if (!Object.hasOwn(sdk.exports, subpath))
        errors.push(`${file}: unknown SDK subpath ${name}`);
      if (!file.startsWith("sdk/"))
        consumers.add(file.split("/").slice(0, 2).join("/"));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
if (exportsChecked < 10 || consumers.size < 3)
  errors.push(
    `insufficient coverage: ${exportsChecked} exports, ${consumers.size} consumers`,
  );
// Workspace metadata must not recreate the old independently versioned SDK packages.
if (
  ["sdk/lib", "sdk/cli", "sdk/engine", "sdk/workflows"].some((path) => {
    const full = join(root, path);
    return existsSync(join(full, "package.json")) && !lstatSync(full).isSymbolicLink();
  })
)
  errors.push("obsolete SDK package manifests remain");
if (!JSON.stringify(entries).includes('"sdk"'))
  errors.push("the workspace inventory omits the SDK");
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(
  `SDK consumers OK (${exportsChecked} resolvable exports, ${consumers.size} external module groups).`,
);
