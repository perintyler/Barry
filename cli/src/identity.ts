#!/usr/bin/env tsx
import { resolve } from "node:path";
import { installedProgramPath } from "@barry-rocks/sdk/internal/services";
import { CLI_SCOPE, type IdentityBinding } from "./scope.js";
const raw = process.argv[2];
if (!raw) throw new Error("generated identity CLI requires a binding");
const binding = JSON.parse(raw) as IdentityBinding;
if (
  !Number.isSafeInteger(binding.id) ||
  binding.id < 1 ||
  (binding.home !== null && typeof binding.home !== "string")
)
  throw new Error("invalid identity CLI binding");
if (binding.home === null) delete process.env.BARRY_HOME;
else process.env.BARRY_HOME = binding.home;
const { openInstance } = await import("@barry-rocks/sdk/internal/services");
const { barryAppSupportDir } = await import("@barry-rocks/sdk/services");
if (
  binding.instance &&
  openInstance(barryAppSupportDir()).id !== binding.instance
)
  throw new Error("identity CLI belongs to another instance");
process.env.BARRY_IDENTITY_BINDING = JSON.stringify(binding);
// Session settings name this as each hook's command (see sdk/src/hooks/hooks.ts).
process.env.BARRY_HOOK_DISPATCHER ??= installedProgramPath("barry-hook");
const { getCurrentUser } = await import("./lib/current-user.js");
const user = await getCurrentUser();
const { identityRecords } = await import("@barry-rocks/identities-bag");
let identity;
if (binding.directory) {
  // The directory this binding names must still be the one carrying its id
  // (pinned in identity.yaml, or the hash of the name it was made from).
  const bound = identityRecords.directory({ id: binding.id });
  if (!bound || resolve(bound) !== resolve(binding.directory))
    throw new Error(
      "identity file no longer matches this CLI binding; regenerate this CLI",
    );
  const synchronized = await identityRecords.sync(binding.directory, {
    actorId: user.id,
  });
  binding.id = synchronized.identityId;
  identity = await identityRecords.row(binding.id);
  process.env.BARRY_IDENTITY_BINDING = JSON.stringify(binding);
} else identity = await identityRecords.row(binding.id);
if (!identity || identity.id !== binding.id || identity.actor_id !== user.id)
  throw new Error(
    "identity binding no longer resolves to its owner; regenerate this CLI",
  );
process.env.BARRY_IDENTITY = identity.name;
process.env.BARRY_IDENTITY_ID = String(identity.id);
(globalThis as Record<symbol, unknown>)[CLI_SCOPE] = {
  kind: "identity",
  binding,
  name: identity.name,
};
process.argv.splice(2, 1);
await import("./main.js");
