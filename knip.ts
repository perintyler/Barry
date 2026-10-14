import { readFileSync } from "node:fs";

const configuration = JSON.parse(readFileSync(new URL("./knip.base.json", import.meta.url), "utf8"));
const sdk = JSON.parse(readFileSync(new URL("./sdk/package.json", import.meta.url), "utf8"));
const publicSources = Object.values(sdk.exports).flatMap((entry: unknown) => {
  const target = typeof entry === "string" ? entry : (entry as { import?: string }).import;
  return target?.startsWith("./dist/")
    ? [target.replace("./dist/", "src/").replace(/\.js$/, ".ts")]
    : [];
});
configuration.workspaces.sdk.entry.push(...publicSources);
export default configuration;
