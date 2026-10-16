const nodePath = (globalThis as { process?: { getBuiltinModule?: (id: string) => typeof import("node:path") | undefined } }).process?.getBuiltinModule?.("node:path");

function posixNormalize(p: string): string {
  const isAbs = p.startsWith("/");
  const parts = p.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!isAbs) out.push("..");
    } else {
      out.push(part);
    }
  }
  const joined = out.join("/");
  return isAbs ? `/${joined}` : joined || ".";
}

function joinPath(...segments: string[]): string {
  if (nodePath) return nodePath.join(...segments);
  return posixNormalize(segments.filter(Boolean).join("/"));
}

function resolvePath(...segments: string[]): string {
  if (nodePath) return nodePath.resolve(...segments);
  let resolved = "";
  for (let i = segments.length - 1; i >= 0 && !resolved.startsWith("/"); i--) {
    const seg = segments[i];
    if (!seg) continue;
    resolved = resolved ? `${seg}/${resolved}` : seg;
  }
  if (!resolved.startsWith("/")) {
    const cwd = (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.() ?? "/";
    resolved = `${cwd}/${resolved}`;
  }
  return posixNormalize(resolved);
}

/**
 * Resolve a user-supplied path the way the builtin tools do: `~`/`~/...`
 * expands against HOME, anything else resolves against the process working
 * directory. Shared so path-based bounds (file-guard deny patterns,
 * read-tracking keys) see the same normalized path the tools actually touch.
 */
export function resolveUserPath(filePath: string): string {
  if (filePath === "~" || filePath.startsWith("~/")) {
    const home = process.env.HOME;
    if (!home) {
      throw new Error(`Cannot expand "~" in path "${filePath}": HOME is not set`);
    }
    return filePath === "~" ? home : joinPath(home, filePath.slice(2));
  }
  if (filePath.startsWith("~")) {
    // `~user` expansion is shell behavior we do not implement; failing loudly
    // beats silently gluing the string onto HOME.
    throw new Error(
      `Unsupported home-relative path "${filePath}" — ~user expansion is not supported; use an absolute path`,
    );
  }
  return resolvePath(filePath);
}
