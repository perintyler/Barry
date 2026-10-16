#!/usr/bin/env tsx
import { mark, span } from "./lib/timing.js";
import { basename } from "node:path";
import { barryVersion } from "./releases/release.js";
import { CLI_TARGET, type IdentityBinding } from "./target.js";
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
const args = process.argv.slice(3);
if (args[0] === "--version" || args[0] === "-V") {
  console.log(barryVersion());
} else if ((args.length === 3 && args[0] === "session" && args[1] === "start") && ["--help", "-h"].includes(args.at(-1)!)) {
  // Presentation needs the generated binding's target; actions still validate
  // the instance and ownership before opening any session.
  const name = process.env.BARRY_IDENTITY ?? (binding.directory ? basename(binding.directory) : String(binding.id));
  (globalThis as Record<symbol, unknown>)[CLI_TARGET] = { kind: "identity", binding, name };
  process.argv.splice(2, 1);
  await import("./main.js");
} else {
  const { openInstance } = await import("@barry-rocks/sdk/internal/services");
  const { barryAppSupportDir } = await import("@barry-rocks/sdk/services");
  if (
    binding.instance &&
    openInstance(barryAppSupportDir()).id !== binding.instance
  )
    throw new Error("identity CLI belongs to another instance");
  mark("identity:binding-validated");
  process.env.BARRY_IDENTITY_BINDING = JSON.stringify(binding);
  const { installedProgramPath } = await import("@barry-rocks/sdk/internal/services");
  // Session settings name this as each hook's command (see sdk/src/hooks/hooks.ts).
  process.env.BARRY_HOOK_DISPATCHER ??= installedProgramPath("barry-hook");
  const { getCurrentUser } = await import("./lib/current-user.js");
  const user = await span("identity:user", () => getCurrentUser());
  const { identityRecords } = await import("@barry-rocks/identities-bag");
  let identity;
  if (binding.directory) {
    const synchronized = await span("identity:synced", () => identityRecords.syncIfChanged(binding.directory!, { actorId: user.id, expectedId: binding.id }));
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
  (globalThis as Record<symbol, unknown>)[CLI_TARGET] = {
    kind: "identity",
    binding,
    name: identity.name,
    record: identity,
  };
  process.argv.splice(2, 1);
  await import("./main.js");
}
