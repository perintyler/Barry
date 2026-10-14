import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";

const identity = parse(readFileSync("identity.yaml", "utf8"));
const names = identity.bags.map(entry => typeof entry === "string" ? entry : Object.keys(entry)[0]);
const expected = names.map(name => `- [${name}](../bags/${name})`).join("\n");
const file = "bags/README.md";
const text = readFileSync(file, "utf8");
const pattern = /<!-- packed-bags:start -->\n[\s\S]*?<!-- packed-bags:end -->/;
const block = `<!-- packed-bags:start -->\n${expected}\n<!-- packed-bags:end -->`;
if (!pattern.test(text)) throw new Error(`${file}: missing packed-bags markers`);
if (process.argv.includes("--write")) writeFileSync(file, text.replace(pattern, block));
else if (!text.includes(block)) {
  console.error(`${file}: packed bags differ from identity.yaml; run node .github/ci/checks/readme-bags.mjs --write`);
  process.exitCode = 1;
} else console.log("README packed bags match identity.yaml.");
