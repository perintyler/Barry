/** Cursor owns its executable discovery; CLI loads only the selected adapter. */
export async function resolveCursorBin(): Promise<string> {
  const { harnessAdapter } = await import("../adapters/installed.js");
  const adapter = await harnessAdapter("cursor");
  if (!adapter.resolveBinary) throw new Error("The selected Cursor adapter does not declare executable resolution; update its package.");
  return adapter.resolveBinary();
}
