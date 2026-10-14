import { bounds } from "@barry-rocks/identities-bag";
import { summarizeBound } from "../lib/bound-summary.js";

export async function boundListCommand(): Promise<void> {
  const allBounds = await bounds.list();

  if (allBounds.length === 0) {
    console.log("No bounds found.");
    return;
  }

  console.log("Bounds:\n");
  for (const bound of allBounds) {
    console.log(`  ${bound.name}`);
    if (bound.description) {
      console.log(`    ${bound.description}`);
    }
    console.log(`    ${summarizeBound(bound)}`);
    console.log("");
  }
}
