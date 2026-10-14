import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const configuration = z.object({
  barry: z.object({
    build: z.object({
      externals: z.array(z.string().regex(/^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/)).optional(),
    }).optional(),
  }).optional(),
});

/** Build settings belong to package metadata, independently of tool visibility. */
export function bagBuildExternals(bagDir: string): string[] {
  const path = join(bagDir, "package.json");
  if (!existsSync(path)) return [];
  try {
    const parsed = configuration.parse(JSON.parse(readFileSync(path, "utf8")));
    return [...new Set(parsed.barry?.build?.externals ?? [])];
  } catch { throw new Error("invalid package.json barry.build.externals: expected package names"); }
}
