import { bounds, identityRecords, type IdentityEntry } from "@barry-rocks/identities-bag";
import { listBoundSessions, convertSessionBounds } from "@barry-rocks/sessions-bag/client";

export async function reportBoundProblems(fix: boolean): Promise<void> {
  const stored = await bounds.stored();
  const names = new Map(stored.map(row => [row.id, row.name]));
  const rows = await listBoundSessions();
  const counts = new Map<number, number>();
  for (const row of rows) if (row.bound_id !== null) counts.set(row.bound_id, (counts.get(row.bound_id) ?? 0) + 1);
  for (const [id, count] of counts) {
    console.log(`${count} session(s) carry bound_id ${id} (${names.get(id) ?? "unknown"}). Run barry doctor --fix to select the bound by name.`);
    if (!names.has(id)) process.exitCode = 1;
  }
  if (fix) {
    const result = await convertSessionBounds(id => names.get(id));
    if (result.converted.length) console.log(`Converted ${result.converted.length} session bound(s).`);
    for (const row of result.unknown) console.log(`Session ${row.id}: unknown bound id ${row.boundId}; left unchanged.`);
  }
  const entries = await identityRecords.list();
  const ordered: IdentityEntry[] = [];
  const visited = new Set<string>();
  function visit(entry: IdentityEntry) {
    if (visited.has(entry.record.name)) return;
    visited.add(entry.record.name);
    const parent = entries.find(candidate => candidate.record.name === entry.record.metadata.inherits);
    if (parent) visit(parent);
    ordered.push(entry);
  }
  for (const entry of entries) visit(entry);
  for (const entry of ordered) {
    const name = entry.record.name;
    if (!identityRecords.inlineBound(name)) continue;
    console.log(`Identity '${name}' writes restrictions inline under bound:. Run barry doctor --fix to move them into bounds:.`);
    if (fix) try {
      await identityRecords.nameInlineBound(name);
      console.log(`  ${name}: moved inline restrictions into required bound '${name}'.`);
    } catch (error) {
      console.log(`  ${name}: ${String(error)}; file unchanged.`);
      process.exitCode = 1;
    }
  }
  for (const shipped of bounds.shipped()) {
    const row = stored.find(row => row.name === shipped.name);
    if (!row) continue;
    const { name: _name, description: _description, ...rules } = shipped;
    if (JSON.stringify(row.bound) !== JSON.stringify(rules)) console.log(`Stored bound '${row.name}' differs from its base identity definition, which shadows it; edit identity.yaml to change the active bound.`);
  }
}
