import { readFileSync, readdirSync } from "node:fs";
import { parse } from "yaml";
import { hasMirrorGuard } from "./mirror-workflows.mjs";

const failures = [];
const workflows = readdirSync(".github/workflows").filter(name => /\.ya?ml$/.test(name));
for (const file of [...workflows.map(name => `.github/workflows/${name}`), ".github/actions/setup/action.yml"]) {
  const source = readFileSync(file, "utf8");
  const document = parse(source);
  if (file.startsWith(".github/workflows/") && !Object.hasOwn(document, "permissions")) failures.push(`${file}: declare top-level permissions`);
  if (file.startsWith(".github/workflows/")) for (const [name, job] of Object.entries(document.jobs ?? {})) {
    if (!hasMirrorGuard(job.if)) failures.push(`${file}: job ${name} must exclude perintyler/barry-dev with the mirror-only guard`);
  }
  function visit(value) {
    if (!value || typeof value !== "object") return;
    if (typeof value.uses === "string" && !value.uses.startsWith("./") && !/^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/.test(value.uses)) failures.push(`${file}: pin ${value.uses} by full commit SHA`);
    for (const child of Object.values(value)) visit(child);
  }
  visit(document);
}
const quarantine = JSON.parse(readFileSync(".github/ci/quarantine.json", "utf8"));
if (!Array.isArray(quarantine)) failures.push("quarantine.json must be an array");
else for (const entry of quarantine) {
  const age = Date.now() - Date.parse(entry.since);
  if (!entry.test || !entry.owner || !/^https:\/\/github.com\/[^/]+\/[^/]+\/issues\/\d+$/.test(entry.issue ?? "") || !Number.isFinite(age) || age < 0 || age > 30 * 86400000) failures.push(`invalid or expired quarantine: ${entry.test ?? "unnamed"}`);
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else console.log(`workflow-security: ${workflows.length} workflows pinned with permissions; quarantine valid`);
