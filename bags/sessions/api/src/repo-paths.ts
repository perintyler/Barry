import { existsSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { homedir } from "os";
import { resolve } from "path";

const execFileAsync = promisify(execFile);

export function expandUserPath(inputPath: string): string {
  return inputPath.startsWith("~") ? inputPath.replace("~", homedir()) : inputPath;
}

export function resolveRepoPath(inputPath: string): string {
  return resolve(expandUserPath(inputPath));
}

/** Session working paths must exist; Git membership is not required. */
export function validateRepoPath(rawPath: string): { ok: true; path: string } | { ok: false; error: string } {
  const resolvedPath = resolveRepoPath(rawPath);

  if (!existsSync(resolvedPath)) {
    return { ok: false, error: `Path does not exist: ${resolvedPath}` };
  }

  return { ok: true, path: resolvedPath };
}

export function requireRepoPath(rawPath: string): string {
  const validated = validateRepoPath(rawPath);
  if (!validated.ok) {
    throw new Error(validated.error);
  }
  return validated.path;
}

// Best-effort git branch detection for a repo path (returns null on failure)
export async function getGitBranch(repoPath: string): Promise<string | null> {
  try {
    const cwd = resolveRepoPath(repoPath);
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 5_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
