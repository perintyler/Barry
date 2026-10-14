import Database from "better-sqlite3";
import { chmodSync, existsSync } from "node:fs";

/** The restore marker closes the gap between stopping the old owner and replacement. */
export function acquireVaultOwnership(path: string): () => void {
  const marker = `${path}.maintenance`;
  if (existsSync(marker)) throw new Error(`Vault maintenance is active; recovery metadata: ${marker}`);
  const lock = new Database(`${path}.owner-lock`, { timeout: 0 });
  try {
    // Persist a protocol stamp before holding the lifetime transaction.
    if (lock.pragma("application_id", { simple: true }) !== 1112951892) lock.pragma("application_id=1112951892");
    chmodSync(`${path}.owner-lock`, 0o600);
    lock.exec("BEGIN IMMEDIATE");
    if (existsSync(marker)) throw new Error(`Vault maintenance is active; recovery metadata: ${marker}`);
  } catch (error) { lock.close(); throw error; }
  let released = false;
  return () => { if (!released) { released = true; try { lock.exec("ROLLBACK"); } finally { lock.close(); } } };
}
