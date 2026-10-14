import { readFileSync, existsSync } from "fs";
import { dirname, join, isAbsolute } from "path";
import { parse } from "yaml";
import { seedBagRegistry, listBags, shippedRegistryEntries } from "../src/bags/registration.js";
import { discoverBuiltinBags } from "@barry-rocks/sdk/internal/bags";

/**
 * Seed what this checkout ships — the bag registry, plus the bounds the base
 * identity defines — and, when one is named, a user YAML.
 *
 * Repeatable.
 *
 * BUILTIN PATHS STAY RELATIVE — to the builtin directory, as discovery reports
 * them (`actions`, `filesystem/locks`). A builtin bag lives inside whichever
 * checkout is running, so its location is a property of the checkout, not of
 * the machine. Absolutizing here would bake the checkout that ran the seed into
 * the shared database — seed from a worktree and prod points at the worktree;
 * move the directory and every builtin breaks. They are resolved at snapshot
 * time against the running checkout instead (resolveBuiltinPath).
 *
 * USER PATHS ARE ABSOLUTIZED. They point outside the repo (~/repos/bags/...,
 * npm dirs) and have no checkout to anchor to.
 *
 * Usage: pnpm --dir sdk seed:bags [user-registry.yaml]
 */
// Filter a literal "--": `pnpm seed:bags -- <path>` forwards the separator
// itself, which once landed here as argv[2] and made the builtin registry seed
// as the USER registry — every builtin absolutized and flagged builtin=false.
const argv = process.argv.slice(2).filter((a) => a !== "--");
const args = argv;

// User bags come only from a file named on the command line: config.db is the
// authority, and a bags.yaml lying around is an export for people, not input.
const userPath = args[0];

function readYaml(p: string | undefined): Record<string, Record<string, unknown>> {
  if (!p) return {};
  if (!existsSync(p)) {
    console.error(`seed:bags: ${p} does not exist`);
    process.exit(1);
  }
  return (parse(readFileSync(p, "utf-8")) ?? {}) as Record<string, Record<string, unknown>>;
}

function absolutize(
  reg: Record<string, Record<string, unknown>>,
  anchorDir: string,
): Record<string, Record<string, unknown>> {
  for (const entry of Object.values(reg)) {
    const path = entry.path;
    if (entry.type === "local" && typeof path === "string" && !isAbsolute(path) && !path.startsWith("~")) {
      entry.path = join(anchorDir, path);
    }
  }
  return reg;
}

// Discovery throws on an authoring error (two bags, one name) — let it: a
// seed that silently picked a winner would be worse than no seed.
const found = discoverBuiltinBags();
if (Object.keys(found.local).length === 0) {
  // Seeding zero builtins is never what anyone meant. It would not demote the
  // existing rows (the demotion pass needs a non-empty shipped set), but it
  // would report success on a checkout whose builtin directory was not found.
  console.error(`seed:bags: no builtin bags found (looked in ${found.dir ?? "no builtin directory"}). Refusing to seed.`);
  process.exit(1);
}
console.log(`builtin directory: ${found.dir}`);

const builtins = shippedRegistryEntries(found);
const users = userPath ? absolutize(readYaml(userPath), dirname(userPath)) : {};

const res = await seedBagRegistry(builtins, users);
console.log(
  `builtins=${res.builtins} users=${res.users} skipped=${res.skipped.length}` +
    (res.retired.length ? ` retired=${res.retired.join(",")}` : ""),
);
const rows = await listBags();
// A USER row with a relative path has no anchor at read time — that is a bug.
// Builtin rows are relative by design.
const badUserPaths = rows.filter((r) => {
  const src = r.source as { type?: string; path?: string };
  return (
    !r.builtin && src.type === "local" && typeof src.path === "string" &&
    !src.path.startsWith("/") && !src.path.startsWith("~")
  );
});
console.log(`table rows: ${rows.length} (builtin=${rows.filter((r) => r.builtin).length})`);
console.log(`user rows with unanchored relative paths: ${badUserPaths.length === 0 ? "none" : badUserPaths.map((r) => r.name).join(", ")}`);

