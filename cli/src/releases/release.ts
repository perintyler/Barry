import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const ReleaseSchema = z.object({
  version: z.string().regex(SEMVER),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  platform: z.literal("darwin-arm64"),
  node: z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  stores: z.record(z.string().regex(/^[^/]+\/[^/]+$/), z.number().int().nonnegative()),
  built: z.iso.datetime(),
}).strict();
export type Release = z.infer<typeof ReleaseSchema>;

/** Where this code is, on purpose: release metadata belongs to its own tree. */
export function releaseRoot(): string { return resolve(import.meta.dirname, "../../.."); }

export function readRelease(root: string): Release | undefined {
  const path = join(root, "release.json");
  if (!existsSync(path)) return undefined;
  return ReleaseSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function describedVersion(repo: string, commit?: string): string | undefined {
  const result = spawnSync("git", ["-C", repo, "describe", "--tags", "--match", "v[0-9]*.[0-9]*.[0-9]*", "--abbrev=12", "--always", ...(commit ? [commit] : ["--dirty"])], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  const described = result.stdout.trim();
  const dirty = described.endsWith("-dirty") ? "-dirty" : "";
  const clean = dirty ? described.slice(0, -dirty.length) : described;
  const tag = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(clean);
  if (tag) return `${tag[1]}${dirty}`;
  if (/^[0-9a-f]{12,}$/.test(clean)) return `0.0.0-g${clean.slice(0, 12)}${dirty}`;
  return commit ? `0.0.0-g${commit.slice(0, 12)}` : undefined;
}

export function versionAt(repo: string, commit: string, ref?: string): string {
  const requested = ref && /^(?:refs\/tags\/)?v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(ref);
  if (requested) {
    const tag = `refs/tags/v${requested[1]}`;
    const resolved = spawnSync("git", ["-C", repo, "rev-parse", "--verify", "--end-of-options", `${tag}^{commit}`], { encoding: "utf8" });
    if (resolved.status !== 0 || resolved.stdout.trim() !== commit) throw new Error(`release tag ${tag} does not resolve to commit ${commit}`);
    return requested[1];
  }
  const version = describedVersion(repo, commit);
  if (!version) throw new Error(`cannot describe commit ${commit}`);
  return version;
}
export function barryVersion(root = releaseRoot()): string {
  const release = readRelease(root);
  if (release) return release.version;
  const file = join(root, "cli", "version.json");
  if (existsSync(file)) {
    const version = z.object({ version: z.string().regex(SEMVER) }).parse(JSON.parse(readFileSync(file, "utf8"))).version;
    return version;
  }
  return `${describedVersion(root) ?? "0.0.0"}-dev`;
}
