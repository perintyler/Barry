export function compiledPackageErrors(pkg, name) {
  const errors = [];
  const fail = message => errors.push(`${name}: ${message}`);
  if (typeof pkg.scripts?.build !== "string") fail("compiled package must define a build script");
  for (const [subpath, entry] of Object.entries(pkg.exports ?? {})) {
    if (typeof entry === "string" && entry.endsWith(".json")) continue;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail(`${subpath} must declare compiled import and types targets`);
      continue;
    }
    const runtime = entry.import;
    const declaration = entry.types;
    if (typeof runtime !== "string" || (!/^\.\/dist\/.+\.(?:js|mjs)$/.test(runtime) || runtime.split("/").includes(".."))) fail(`${subpath} import must point to compiled JavaScript in dist`);
    if (typeof declaration !== "string" || (!/^\.\/dist\/.+\.d\.(?:ts|mts)$/.test(declaration) || declaration.split("/").includes(".."))) fail(`${subpath} types must point to declarations in dist`);
    if (Object.keys(entry).some(key => !["types", "import"].includes(key))) fail(`${subpath} contains unsupported export conditions`);
  }
  if (!pkg.exports?.["."]) fail("compiled package must export its root");
  return errors;
}
