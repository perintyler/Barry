/** Process entry for scheduled operations: resolve once, then enter the bound identity CLI. */
import {
  getCurrentUser,
  getPersistedActiveIdentity,
} from "./lib/current-user.js";
import { identityRecords } from "@barry-rocks/identities-bag";
import { openInstance } from "@barry-rocks/sdk/internal/services";
import { barryAppSupportDir } from "@barry-rocks/sdk/services";
const user = await getCurrentUser();
const name = process.env.BARRY_IDENTITY || getPersistedActiveIdentity(user);
if (!name && !process.env.BARRY_IDENTITY_BINDING)
  throw new Error("automation requires a configured identity");
// The identity as the operation finds it: its directory first, carrying its
// row's id. One with no row yet carries a hash of its name, which binds no
// row, so it is as absent here as it always was.
const found = name ? await identityRecords.find(name).catch(() => undefined) : undefined;
const identity = found && (await identityRecords.row(found.record.id)) ? found : undefined;
if (!identity && !process.env.BARRY_IDENTITY_BINDING)
  throw new Error("automation identity no longer exists");
const directory = identity?.dir ?? undefined;
const binding =
  process.env.BARRY_IDENTITY_BINDING ??
  JSON.stringify({
    id: identity!.record.id,
    home: process.env.BARRY_HOME ?? null,
    instance: openInstance(barryAppSupportDir()).id,
    ...(directory ? { directory } : {}),
  });
process.argv.splice(2, 0, binding);
await import("./identity.js");
