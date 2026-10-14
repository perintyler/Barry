import { Barry } from "@barry-rocks/sdk";
import { owner, type UserRecord } from "@barry-rocks/identities-bag";

export type User = UserRecord;

/**
 * Resolve this installation's bound user without changing ownership.
 */
export async function getCurrentUser(): Promise<UserRecord> {
  const user = await owner.current();
  if (!user) throw new Error("Installation owner unresolved. Run barry setup, or bind an existing user with barry owner <actor-id>.");
  return user;
}

/**
 * Set the active barry: the owner's default, which unqualified commands act as.
 *
 * The stored key is still `defaultBarry`: it round-trips through exported
 * settings.yaml and the `/set-default` route, so renaming it is a format
 * change, not a rename. "Active" is the user-facing word.
 */
export async function setActiveIdentity(identityName: string): Promise<void> {
  await Barry.identity(identityName).makeDefault();
}

/**
 * Which identity a command should act on.
 *
 * `BARRY_IDENTITY` wins, because that is what a per-identity command (`bux …`)
 * sets: running `bux show` has to describe bux, not whatever the persisted
 * default happens to be. Every command that resolves "the identity to act on"
 * goes through here, so the override reaches all of them rather than the
 * handful someone remembered to update.
 *
 * Use `getPersistedActiveIdentity` where the *stored* default is the subject —
 * reporting it, or changing it.
 */
export function getActiveIdentity(user: UserRecord): string | null {
  const override = process.env.BARRY_IDENTITY?.trim();
  if (override) return override;
  return getPersistedActiveIdentity(user);
}

/** The default recorded in user settings, ignoring any per-command override. */
export function getPersistedActiveIdentity(user: UserRecord): string | null {
  return (user.settings.defaultBarry as string) || null;
}
