import type { AuthPrincipal } from "./principal.js";

export function samePrincipal(left: AuthPrincipal, right: AuthPrincipal): boolean {
  if (left.kind !== right.kind || left.actorId !== right.actorId || left.credentialId !== right.credentialId) return false;
  if (left.kind === "installation" || right.kind === "installation") return true;
  return left.scopes.length === right.scopes.length && left.scopes.every(scope => right.scopes.includes(scope))
    && left.identityIds.length === right.identityIds.length && left.identityIds.every(id => right.identityIds.includes(id));
}
