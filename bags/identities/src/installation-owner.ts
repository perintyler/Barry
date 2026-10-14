import { getIdentitiesSqlite } from "./store/identities-db.js";
import { InstallationOwner } from "./store/installation-owner.js";

export function installationOwner(): InstallationOwner { return new InstallationOwner(getIdentitiesSqlite()); }
export type { InstallationOwnerRecord, InstallationOwnerSelection } from "./store/installation-owner.js";
