import { getIdentitiesSqlite, identitiesDbPath } from "./store/identities-db.js";
import { watchAuthorizationChanges } from "./store/authorization-changes.js";
import { DeviceStore } from "./store/devices.js";
import { verifyInstallationCredential, AuthPrincipalSchema, InstallationPrincipalSchema, type AuthPrincipal } from "@barry-rocks/sdk/internal/auth";

import { installationOwner } from "./installation-owner.js";

/** Management and verification stay inside the identities store owner. */
export function devices(): DeviceStore { return new DeviceStore(getIdentitiesSqlite()); }

export function subscribeAuthorizationChanges(listener: () => void | Promise<void>): () => void {
  return watchAuthorizationChanges(identitiesDbPath(), listener);
}

export async function installationOperator(): Promise<number | null> {
  return installationOwner().current()?.actorId ?? null;
}

export async function verifyRequestCredential(credential: string): Promise<AuthPrincipal | null> {
  if (!verifyInstallationCredential(credential)) return devices().verify(credential);
  const actorId = await installationOperator();
  if (actorId === null) throw new Error("Installation owner unresolved");
  return InstallationPrincipalSchema.parse({ kind: "installation", actorId, credentialId: "installation" });
}

/** Resource guards use this after credential verification, never as authentication by actor or device ID. */
export async function revalidateRequestPrincipal(input: AuthPrincipal): Promise<AuthPrincipal | null> {
  const parsed = AuthPrincipalSchema.safeParse(input);
  if (!parsed.success) return null;
  if (parsed.data.kind === "device") return devices().revalidate(parsed.data);
  return (await installationOperator()) === parsed.data.actorId ? parsed.data : null;
}
export { DevicePairingError } from "./store/devices.js";
export type { DeviceRecord, PairingInput, PairingGrant, PairingRequest, PairingClaim } from "./store/devices.js";
