import { barryStoresDir } from "@barry-rocks/sdk/services";
import { pruneStoreGenerations } from "@barry-rocks/sdk/internal/stores";

function size(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} bytes`;
}
export async function pruneOlderGenerations(root: string): Promise<string[]> {
  try {
    const result = await pruneStoreGenerations(root);
    return result.removed.map(entry => `  removed older generation ${entry.id} (${size(entry.bytes)})`);
  } catch (error) {
    return [`could not remove older generations: ${error instanceof Error ? error.message : String(error)}. Run \`barry db prune\` later.`];
  }
}
export async function dbPruneCommand(options: { yes?: boolean; confirm?(message: string): Promise<boolean> } = {}): Promise<void> {
  const root = barryStoresDir(), preview = await pruneStoreGenerations(root, { dryRun: true });
  if (!preview.removed.length) {
    const active = preview.kept.find(entry => entry.reason === "active"), previous = preview.kept.find(entry => entry.reason === "previous");
    console.log(active ? `Nothing to prune: generation ${active.id} is active${previous ? ` and ${previous.id} is kept for \`barry db rollback\`` : "; no previous generation is recorded"}.` : "Nothing to prune: no active store generation.");
    return;
  }
  for (const entry of preview.kept) console.log(`  keep generation ${entry.id} (${entry.reason})`);
  for (const entry of preview.removed) console.log(`  remove generation ${entry.id} (${size(entry.bytes)})`);
  console.log(`Total to remove: ${size(preview.removed.reduce((total, entry) => total + entry.bytes, 0))}`);
  if (!options.yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Unattended prune requires --yes");
    const message = "Delete the older store generations?";
    const confirmed = options.confirm ? await options.confirm(message) : await (await import("@inquirer/prompts")).confirm({ message, default: false });
    if (!confirmed) { console.log("No changes made."); return; }
  }
  const result = await pruneStoreGenerations(root);
  for (const entry of result.removed) console.log(`  removed older generation ${entry.id} (${size(entry.bytes)})`);
  console.log(`Freed ${size(result.removed.reduce((total, entry) => total + entry.bytes, 0))}.`);
}
