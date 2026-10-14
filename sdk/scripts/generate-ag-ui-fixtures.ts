import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { agUiWireFixtures } from "./ag-ui-fixtures.js";

const barryKitDir = process.env.BARRY_KIT_DIR;
const output = `${JSON.stringify(agUiWireFixtures(), null, 2)}\n`;
const outputs: string[] = [];
if (barryKitDir !== undefined && existsSync(barryKitDir)) outputs.push(resolve(barryKitDir, "Tests/Fixtures/ag-ui.json"));
for (const path of outputs) {
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== output) {
      throw new Error(`Generated AG-UI fixtures are stale: ${path}. Run: pnpm contracts:generate`);
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, output);
  }
}
console.log(`AG-UI fixtures ${process.argv.includes("--check") ? "in sync" : "written"} (${outputs.length} targets): ${outputs.join(", ")}`);
if (barryKitDir === undefined || !existsSync(barryKitDir)) console.log(`SKIPPED the Swift fixtures: ${barryKitDir === undefined ? "BARRY_KIT_DIR is not set" : `no BarryKit at ${barryKitDir}`}`);
