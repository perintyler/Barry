import { listStores, verifyStore, type StoreInfo } from "@barry-rocks/sdk/internal/stores";
import { currentTarget } from "../target.js";
import { bold, dim, green, red } from "../lib/ansi.js";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function storeLabel(s: StoreInfo): string {
  if (s.scope === "node") return `[node] ${s.bag}:${s.store}`;
  const id = s.identityName ? s.identityName : s.identityId ? `id:${s.identityId}` : "unknown";
  return `[${id}] ${s.bag}:${s.store}`;
}

export async function storeListCommand(options: { json?: boolean } = {}): Promise<void> {
  const target = currentTarget();
  const identityFilter = target.kind === "identity" ? target.name : undefined;
  const stores = await listStores(identityFilter ? { identity: identityFilter } : undefined);

  // If in identity target, only show stores belonging to that identity or shared node stores
  const filtered = target.kind === "identity"
    ? stores.filter(s => s.scope === "node" || s.identityName === target.name)
    : stores;

  if (options.json) {
    console.log(JSON.stringify({ scope: target.kind, count: filtered.length, stores: filtered }, null, 2));
    return;
  }

  const title = target.kind === "identity"
    ? `Stores for identity ${bold(target.name)}`
    : `Barry Stores · system wide (${filtered.length} stores)`;

  console.log();
  console.log(`  ${bold(title)}`);
  console.log(`  ${dim("─".repeat(70))}`);

  const sorted = [...filtered].sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === "node" ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  for (const s of sorted) {
    const label = storeLabel(s).padEnd(35);
    const size = formatBytes(s.bytes).padStart(9);
    const wal = s.walBytes > 0 ? dim(` (WAL ${formatBytes(s.walBytes)})`) : "";
    const meta = dim(`ver: ${s.version} · tables: ${s.tables}`);
    console.log(`  ● ${label} ${size}${wal}   ${meta}`);
  }
  console.log();
}

export async function storeVerifyCommand(options: { deep?: boolean; json?: boolean } = {}): Promise<void> {
  const target = currentTarget();
  const identityFilter = target.kind === "identity" ? target.name : undefined;
  const stores = await listStores(identityFilter ? { identity: identityFilter } : undefined);

  const filtered = target.kind === "identity"
    ? stores.filter(s => s.scope === "node" || s.identityName === target.name)
    : stores;

  const results = filtered.map(s => verifyStore(s, { deep: options.deep }));
  const hasErrors = results.some(r => !r.ok);

  if (options.json) {
    console.log(JSON.stringify({ ok: !hasErrors, verified: results.length, results }, null, 2));
    if (hasErrors) process.exitCode = 1;
    return;
  }

  const title = target.kind === "identity"
    ? `Verifying stores for identity ${bold(target.name)}`
    : `Verifying Barry Stores (${filtered.length} stores)`;

  console.log();
  console.log(`  ${bold(title)}`);
  console.log(`  ${dim("─".repeat(70))}`);

  for (const r of results) {
    const label = storeLabel(r.store).padEnd(35);
    const mark = r.ok ? green("●") : red("✗");
    const status = r.ok ? green("integrity ok") : red(r.error ?? r.integrity);
    console.log(`  ${mark} ${label} ${status}`);
  }

  console.log();
  if (hasErrors) {
    console.log(`  ${red("✗ Some stores failed integrity verification")}`);
    process.exitCode = 1;
  } else {
    console.log(`  ${green(`✓ All ${results.length} stores intact`)}`);
  }
  console.log();
}
