/**
 * Who may reach Barry: the installation's owner, the users it knows, and the
 * devices paired with it. Credential verification and revalidation are what
 * the HTTP services' `applyAuth` calls; the owner and device stores are what
 * `barry setup`, `barry owner` and the pairing routes manage.
 */
import { Users } from "../store/users.js";
import {
  devices,
  installationOperator,
  revalidateRequestPrincipal,
  subscribeAuthorizationChanges,
  verifyRequestCredential,
} from "../devices.js";
import { installationOwner } from "../installation-owner.js";

export const access = {
  verifyCredential: verifyRequestCredential,
  revalidate: revalidateRequestPrincipal,
  /** Called whenever a credential is granted, revoked or changes owner. */
  subscribe: subscribeAuthorizationChanges,
  /** The actor the instance secret acts as, or null before setup. */
  operator: installationOperator,
  devices: devices,
};

export const owner = {
  /** The installation's owner as a user, or undefined before setup binds one. */
  current: Users.getInstallationOwner,
  /** Provision, bind or read the installation's owner. */
  installation: installationOwner,
  users: {
    list: Users.list,
    get: Users.get,
    byToken: Users.getByToken,
    byEmail: Users.getByEmail,
    create: Users.create,
    updateSettings: Users.updateSettings,
  },
};
