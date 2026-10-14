import { copyFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const target = resolve(process.argv[2] ?? process.cwd());
const manifest = JSON.parse(readFileSync(resolve(target, "package.json"), "utf8"));
if (manifest.license !== "SEE LICENSE IN LICENSE.md") {
  throw new Error(`${manifest.name}: package license preparation requires the local LICENSE.md reference`);
}
if (target !== root) copyFileSync(resolve(root, "LICENSE.md"), resolve(target, "LICENSE.md"));
