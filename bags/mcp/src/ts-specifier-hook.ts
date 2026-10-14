import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Covers the bags that still load from TypeScript source — `BARRY_BAGS_BUILT=0`
 * and bags the builder could not handle; built output is the normal path (see
 * loadBagTools). Under tsx source loading works because tsx rewrites relative
 * ".js" specifiers to ".ts" files; the prod bundle runs under plain Node,
 * whose native type stripping does NOT rewrite specifiers — so a bag's
 * `export * from "./src/tools.js"` fails with ERR_MODULE_NOT_FOUND.
 *
 * This hook retries failed relative ".js" resolutions as ".ts". It only
 * fires when default resolution fails, so it is inert under tsx and for
 * every normal import.
 */
export function registerTsSpecifierHook(): { deregister(): void } {
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (
          (specifier.startsWith("./index.ts") || specifier.startsWith("@barry-rocks/sdk/mcp")) &&
          specifier.endsWith(".js") &&
          typeof context.parentURL === "string" &&
          context.parentURL.startsWith("file:")
        ) {
          const tsSpecifier = `${specifier.slice(0, -3)}.ts`;
          const candidate = new URL(tsSpecifier, context.parentURL);
          if (existsSync(fileURLToPath(candidate))) {
            return nextResolve(tsSpecifier, context);
          }
        }
        throw error;
      }
    },
  });
}
