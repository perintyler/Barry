import { readFileSync } from "node:fs";
const pin = JSON.parse(readFileSync("cli/src/services/node-runtime.json", "utf8"));
const response = await fetch(`https://nodejs.org/dist/v${pin.version}/SHASUMS256.txt`, { signal: AbortSignal.timeout(30000) });
if (!response.ok) throw new Error(`Node checksum manifest: HTTP ${response.status}`);
const sums = new Map((await response.text()).trim().split("\n").map(line => line.trim().split(/\s+/).reverse()));
for (const [arch, expected] of Object.entries(pin.sha256)) {
  const filename = `node-v${pin.version}-darwin-${arch}.tar.gz`;
  if (sums.get(filename) !== expected) throw new Error(`${filename}: pinned digest differs from nodejs.org`);
}
console.log(`Node ${pin.version}: both runtime digests match upstream`);
