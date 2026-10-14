/** Read-only target inspection; writes protected recovery material only to a new output directory. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { launchd } from "@barry-rocks/mcp-bag";
const [rawHome, rawOutput] = process.argv.slice(2);
if (!rawHome?.startsWith("/") || !rawOutput?.startsWith("/")) throw new Error("usage: inventory-installation.ts <absolute-instance-home> <absolute-new-protected-output>");
const home = resolve(rawHome), output = resolve(rawOutput);
if (!existsSync(join(home, "instance.json"))) throw new Error("target must have an existing instance identity");
if (existsSync(output) || home === output) throw new Error("output must be a new separate directory");
mkdirSync(output, { recursive: true, mode: 0o700 });
const instance = JSON.parse(readFileSync(join(home, "instance.json"), "utf8"));
const os = launchd(), domain = `gui/${instance.uid ?? statSync(join(home, "instance.json")).uid}`;
const problems: string[] = [], files: Array<{ path: string; sha256: string }> = [];
const copy = (source: string, target: string) => { mkdirSync(resolve(target, ".."), { recursive: true, mode: 0o700 }); cpSync(source, target); files.push({ path: target, sha256: createHash("sha256").update(readFileSync(target)).digest("hex") }); };
for (const name of ["env", "instance.json", "launchd-items.json", "bags.snapshot.json", "bag-resources.json", "ports.json", "services.json", "managed-definitions.json", "service-definitions.json"]) {
  if (existsSync(join(home, name))) copy(join(home, name), join(output, "configuration", name));
}
const ownership = existsSync(join(home, "launchd-items.json")) ? JSON.parse(readFileSync(join(home, "launchd-items.json"), "utf8")).items : [];
const jobs: Array<Record<string, unknown>> = [];
for (const item of ownership) {
  const state = os.inspect(item.domain ?? domain, item.label);
  try {
    const contents = readFileSync(item.plist), value = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", item.plist], { encoding: "utf8" }));
    copy(item.plist, join(output, "registrations", item.label + ".plist"));
    jobs.push({ label: item.label, domain: item.domain ?? domain, pid: state.pid, loaded: state.loaded, enabled: os.policy!(item.domain ?? domain, item.label),
      command: value.ProgramArguments, directory: value.WorkingDirectory, user: value.UserName, environmentNames: Object.keys(value.EnvironmentVariables ?? {}), sha256: createHash("sha256").update(contents).digest("hex") });
  } catch (error) { problems.push(`${item.label}: ${String(error)}`); }
}
// Enumerate privileged Barry jobs without printing or copying resolved environment values.
const systemJobs = readdirSync("/Library/LaunchDaemons").filter(name => name.startsWith("com.barry.") && name.endsWith(".plist")).map(name => {
  const label = name.slice(0, -6), state = os.inspect("system", label);
  let readable = true; try { readFileSync(join("/Library/LaunchDaemons", name)); } catch { readable = false; }
  if (!readable) problems.push(`${label}: administrative read required for protected registration`);
  return { label, domain: "system", loaded: state.loaded, pid: state.pid, readable };
});
const databases: Array<Record<string, unknown>> = [];
async function stores(directory: string): Promise<void> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { if (!["node_modules", "cache", "acceptance", "releases"].includes(entry.name) && path !== output) await stores(path); continue; }
    if (!/\.(?:db|sqlite|sqlite3)$/.test(entry.name)) continue;
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => String(row.name));
      const versions = Object.fromEntries(tables.filter(name => /migration|version|workflow_meta/.test(name)).map(name => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]));
      const relative = path.slice(home.length + 1), target = join(output, "stores", relative); mkdirSync(resolve(target, ".."), { recursive: true, mode: 0o700 });
      await backup(db, target); files.push({ path: target, sha256: createHash("sha256").update(readFileSync(target)).digest("hex") });
      databases.push({ path, snapshot: target, tables, versions, quickCheck: db.prepare("PRAGMA quick_check").get() });
    } finally { db.close(); }
  }
}
await stores(home);
const processes = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,lstart=,command="], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).trim().split("\n");
// Store only process identities/parentage; arbitrary argv can contain credentials.
const processIdentities = processes.map(line => /^\s*(\d+)\s+(\d+)\s+((?:\S+\s+){4}\S+)/.exec(line)).filter(Boolean).map(match => ({ pid: Number(match![1]), parent: Number(match![2]), started: match![3] }));
const report = { instance: instance.id, home, domain, created: new Date().toISOString(), node: process.version, jobs, systemJobs, databases, processIdentities, files, problems };
writeFileSync(join(output, "inventory.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ instance: instance.id, output, ownedRegistrations: jobs.length, systemRegistrations: systemJobs.length, databaseSnapshots: databases.length, problems }, null, 2));
