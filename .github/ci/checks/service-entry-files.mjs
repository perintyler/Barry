import { posix } from "node:path";
/** Entry declarations are bag-relative; explicit interpreter arguments retain their cwd. */
export function serviceEntryFiles(manifest, services) {
  const bagDirectory = posix.dirname(manifest);
  const files = [];
  for (const service of Object.values(services)) {
    if (typeof service.entry === "string") {
      files.push(posix.normalize(posix.join(bagDirectory, service.entry)));
      continue;
    }
    const cwd = service["working-directory"] ?? ".";
    for (const arg of service.args ?? []) {
      if (typeof arg === "string" && /\.(?:[cm]?[jt]s|tsx)$/.test(arg)) files.push(posix.normalize(posix.join(bagDirectory, cwd, arg)));
    }
  }
  return files;
}
