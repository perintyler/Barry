import type { RequestAuthorizationOptions } from "@barry-rocks/sdk/internal/auth";
import { hasIdentityGrant } from "@barry-rocks/sdk/internal/auth";
import { revalidateRequestPrincipal, verifyRequestCredential } from "./devices.js";
import { Identities } from "./store/identities.js";

export function identityRequestAuthorization(): RequestAuthorizationOptions {
  return {
    verifyCredential: verifyRequestCredential,
    policy: request => {
      if (request.method !== "GET") return null;
      const match = /^\/api\/v1\/identities\/([^/]+)\/?$/.exec(request.path);
      const ref = match?.[1];
      if (!ref || ref === "effective" || ref === "bags") return null;
      return {
        scopes: ["identities:read"],
        authorize: async (principal, _request, signal) => {
          const identity = /^[1-9][0-9]*$/.test(ref)
            ? await Identities.get(Number(ref))
            : await Identities.getByName(principal.actorId, ref);
          if (!identity || !hasIdentityGrant(principal, identity.id)) return false;
          signal.throwIfAborted();
          return identity?.actor_id === principal.actorId && Boolean(await revalidateRequestPrincipal(principal));
        },
      };
    },
  };
}
