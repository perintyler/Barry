import { createRequire } from "node:module";
import { resolve } from "node:path";

const { ESLint } = createRequire(resolve("package.json"))("eslint");
// Apply Barry's tooling rules to the checks even though they live outside its tree.
const config = await new ESLint().calculateConfigForFile(".github/ci/run.mjs");
if (!config) throw new Error("Barry's CI launcher has no lint configuration");
const eslint = new ESLint({
  cwd: import.meta.dirname,
  overrideConfigFile: true,
  overrideConfig: Object.fromEntries(
    ["languageOptions", "linterOptions", "plugins", "rules", "settings"]
      .filter((key) => config[key] !== undefined)
      .map((key) => [key, config[key]]),
  ),
});
const results = await eslint.lintFiles(["**/*.mjs"]);
const formatter = await eslint.loadFormatter("stylish");
const output = formatter.format(results);
if (output) console.log(output);
if (results.some((result) => result.errorCount || result.warningCount)) process.exitCode = 1;
