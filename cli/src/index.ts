#!/usr/bin/env tsx
import { mark } from "./lib/timing.js";

import { CLI_TARGET, type IdentityBinding } from "./target.js";

function extractIdentityArg(argv: string[]): { name?: string; cleanArgv: string[] } {
  const cleanArgv: string[] = [];
  let name: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--identity" || arg === "-i") {
      if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        name = argv[i + 1];
        i++;
        continue;
      }
      console.error(`Error: option '${arg}' argument missing`);
      process.exit(1);
    } else if (arg.startsWith("--identity=")) {
      name = arg.slice("--identity=".length);
      if (!name) {
        console.error("Error: option '--identity=' argument missing");
        process.exit(1);
      }
      continue;
    }
    cleanArgv.push(arg);
  }
  return { name, cleanArgv };
}

const { name: identityName, cleanArgv } = extractIdentityArg(process.argv);
if (identityName) {
  const { getCurrentUser } = await import("./lib/current-user.js");
  const user = await getCurrentUser().catch(() => null);
  const { identityRecords } = await import("@barry-rocks/identities-bag");

  const dir = identityRecords.directory({ name: identityName });
  let identity;
  if (dir && user) {
    const synchronized = await identityRecords.syncIfChanged(dir, { actorId: user.id });
    identity = await identityRecords.row(synchronized.identityId);
  } else if (user) {
    identity = await identityRecords.byReference(identityName);
  }

  if (!identity || !user || identity.actor_id !== user.id) {
    console.error(`Error: Identity "${identityName}" not found.`);
    console.error(`Run "barry identity list" to see available identities.`);
    process.exit(1);
  }

  const binding: IdentityBinding = {
    id: identity.id,
    home: process.env.BARRY_HOME ?? null,
    ...(dir ? { directory: dir } : {}),
  };
  process.env.BARRY_IDENTITY = identity.name;
  process.env.BARRY_IDENTITY_ID = String(identity.id);
  process.env.BARRY_IDENTITY_BINDING = JSON.stringify(binding);
  (globalThis as Record<symbol, unknown>)[CLI_TARGET] = {
    kind: "identity",
    binding,
    name: identity.name,
  };
  process.argv = cleanArgv;
} else {
  (globalThis as Record<symbol, unknown>)[CLI_TARGET] = { kind: "system" };
  delete process.env.BARRY_IDENTITY;
  delete process.env.BARRY_IDENTITY_ID;
  delete process.env.BARRY_IDENTITY_BINDING;
}

const { dispatchSkew } = await import("./releases/skew.js");
const handedOver = await dispatchSkew().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
  return true;
});
mark("skew:checked");
if (!handedOver) {
  const { installedProgramPath } = await import("@barry-rocks/sdk/internal/services");
  // Session settings name this as each hook's command (see sdk/src/hooks/hooks.ts).
  process.env.BARRY_HOOK_DISPATCHER ??= installedProgramPath("barry-hook");
  await import("./main.js");
}
