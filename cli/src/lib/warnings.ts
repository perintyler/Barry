/**
 * How the terminal presents the warnings a change raised beside its value. A
 * refusal is a thrown `BarryError`, which commands already print from their
 * catch like every other failure.
 */
import type { Warning } from "@barry-rocks/sdk";

export function printWarnings(warnings: readonly Warning[] | undefined): void {
  for (const warning of warnings ?? []) {
    console.warn(`warning: ${warning.message}`);
    if (warning.hint) console.warn(`  ${warning.hint}`);
  }
}
