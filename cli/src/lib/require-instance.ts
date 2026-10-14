/**
 * One answer to "is this instance set up?", shared by `status`, `service *`,
 * `app *` and `hosting *` so they cannot disagree on a fresh install (CLI-11).
 *
 * A fresh instance has no owner bound and no service registry on disk. Before
 * this, each of those commands answered differently: `status` printed an empty
 * instance id with exit 0, `service list` printed nothing with exit 0,
 * `service status`/`app list` errored with exit 1, and `hosting status`
 * printed a sentence with exit 0. Now the four route through one check that
 * throws a `CliError` with the one message and exit code 3.
 */
import { CliError } from "./cli-error.js";

/** The exit code every not-set-up refusal uses. */
export const NOT_SET_UP_EXIT = 3;

/** The one message every not-set-up refusal prints. */
export const NOT_SET_UP_MESSAGE =
  "This instance is not set up: no owner and no service registry. Run barry setup.";

/** True once an instance has an owner or a service registry — the inverse of fresh. */
export async function isInstanceSetUp(): Promise<boolean> {
  const { existsSync } = await import("node:fs");
  const { serviceRegistryPath } = await import("@barry-rocks/sdk/services");

  let hasOwner = false;
  try {
    const { owner } = await import("@barry-rocks/identities-bag");
    hasOwner = (await owner.installation()).current() !== null;
  } catch {
    // No identities store yet: treat as no owner.
  }

  let hasRegistry = false;
  try {
    hasRegistry = existsSync(serviceRegistryPath());
  } catch {
    hasRegistry = false;
  }

  // Set up if EITHER is present. A fresh instance has neither.
  return hasOwner || hasRegistry;
}

/**
 * Throw the one not-set-up refusal when this instance is fresh.
 *
 * `CliError` carries exit code 3 to `main.ts`'s handler, which sets the process
 * exit code, so callers never reach `process.exit` for this case.
 */
export async function requireInstance(): Promise<void> {
  if (!(await isInstanceSetUp())) throw new CliError(NOT_SET_UP_MESSAGE, NOT_SET_UP_EXIT);
}
