import { resolve, sep } from "node:path";
import { tmpdir } from "node:os";

/**
 * Admit :memory: and lexical OS-temp descendants during tests. This checks
 * path prefixes, not symlink targets or whether a scratch store is shared.
 * See docs/decisions/0038-test-isolation-and-command-reservations.md.
 */
function isScratchPath(path: string): boolean {
  if (path === ":memory:") return true;

  const resolved = resolve(path);
  const temp = tmpdir();
  // Both spellings of macOS's /var -> /private/var symlink. The trailing
  // separator matters: without it, `/tmpfoo/x` would count as being under
  // `/tmp`.
  const roots = [temp, resolve(temp), `/private${temp}`];
  return roots.some((root) => resolved === root || resolved.startsWith(root.endsWith(sep) ? root : root + sep));
}

/**
 * Enforce scratch paths at store opening under VITEST, unless the explicit
 * BARRY_ALLOW_NON_TEST_STORE opt-out is set. Path-only lookups do not open stores.
 * See docs/decisions/0038-test-isolation-and-command-reservations.md.
 */
export function assertScratchStoreUnderTest(label: string, path: string): void {
  if (!process.env.VITEST) return;
  if (process.env.BARRY_ALLOW_NON_TEST_STORE === "1") return;
  if (isScratchPath(path)) return;

  throw new Error(
    `Refusing to open the ${label} store at ${path} from a test run — under VITEST a store `
      + `must live in a scratch location (the OS temp directory, ${tmpdir()}, or ":memory:"). `
      + `This path is the real store, so a suite is running without its store pinned: set the `
      + `override env var to a temp path, e.g. `
      + `process.env.BARRY_${label.toUpperCase()}_DB = join(mkdtempSync(join(tmpdir(), "barry-")), "${label}.db"); `
      + `check for a missing vitest config. Set BARRY_ALLOW_NON_TEST_STORE=1 only if opening the `
      + `real store is genuinely what the test is for.`,
  );
}
