import { readFileSync, writeFileSync } from "node:fs";
import { check, format, resolveConfig } from "prettier";

const files = JSON.parse(readFileSync("format-files.json", "utf8"));
if (!Array.isArray(files) || files.length === 0 || files.some(file => typeof file !== "string")) throw new Error("Formatter scope must contain source files");
const write = process.argv.includes("--write");
let failures = 0;
for (const file of files) {
  const source = readFileSync(file, "utf8");
  const options = { ...await resolveConfig(file), filepath: file };
  if (write) writeFileSync(file, await format(source, options));
  else if (!await check(source, options)) {
    console.error(`Formatting required: ${file}`);
    failures++;
  }
}
console.log(`${files.length} formatter targets ${write ? "written" : "checked"}; ${failures} failures`);
process.exitCode = failures ? 1 : 0;
