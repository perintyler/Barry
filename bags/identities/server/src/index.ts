import { identitiesApi } from "./app.js";
/**
 * The identities service: identity and bound management.
 *
 * Split out of bags/sessions/api, which had grown to carry both session lifecycle and
 * identity administration — two surfaces with different shapes of traffic and
 * almost no shared code. Measured before the split: of ~19 local modules in
 * that server, exactly three were used by both halves, and all three are now in
 * shared packages.
 *
 * What it deliberately does NOT have, compared to the session service: no
 * websocket server, no session runtime, no crashed-session sweep, no
 * summarizer, no TTL cleanup. Identity administration is request/response, so
 * its boot is a fraction of the other's.
 */
import { Barry } from "@barry-rocks/sdk";
import { loadAdapters } from "@barry-rocks/sdk/internal/adapters";
import { createModels, installModels, installedModels, loadModelVendors, assembleVendors, mergeVendorFactories, registeredVendorRows } from "@barry-rocks/sdk/adapters/models";
import { createLogger, setupGracefulShutdown } from "@barry-rocks/sdk/logging";
import { validateEnv, barryAdaptersPath, barryVendorAdaptersPath, assignedPort, listenOnAssignedPort } from "@barry-rocks/sdk/services";
import { sessions } from "@barry-rocks/sessions-bag";
import { identities, bags } from "../../src/index.js";
import { setIdentityModels } from "../../src/models.js";

const log = createLogger("barry-identities");
// The service toolkit declares the logger shape and takes the factory as an
// injection, so it depends on no logging implementation. This is the
// composition root, so naming one here is its job.

// What a default model is checked against: the registered vendors, and the
// harnesses recorded in adapters.json. The models this root installs are
// named here because naming them is its job: registered bags' vendor declarations plus
// installed adapters' vendor code, loaded from their records.
const adapters = loadAdapters({ file: barryAdaptersPath() });
const shippedVendorRows = registeredVendorRows();
const installedVendorCode = await adapters.loadVendorCode();
for (const [id, problems] of installedVendorCode.refused) {
  log.error("models.vendor-code-refused", { adapter: id, problems });
}
const vendorAdapters = loadModelVendors({ file: barryVendorAdaptersPath() });
const vendorFactories = await vendorAdapters.load();
for (const [packageName, problems] of vendorAdapters.refused) {
  log.error("models.vendor-refused", { packageName, problems });
}
installModels(
  createModels(
    assembleVendors([...shippedVendorRows, ...adapters.installed().filter((r) => !r.bag).flatMap((r) => r.vendorCode?.vendors ?? [])], mergeVendorFactories(
            vendorFactories,
            installedVendorCode.factories,
          )),
  ),
);
setIdentityModels({ vendors: () => installedModels().vendors(), harnesses: () => adapters.installed() });

// The subjects this service answers for in-process; removing an identity removes its sessions.
Barry.use(identities, bags, sessions);


const envCheck = validateEnv({ service: "api" });
if (!envCheck.ok) {
  for (const m of envCheck.missing) log.error("env.required", { var: m.name, description: m.description });
  process.exit(1);
}
if (!process.env.BARRY_SECRET) {
  log.error("env.required", { var: "BARRY_SECRET", description: "Authenticates API clients" });
  process.exit(1);
}

const { app } = identitiesApi();

listenOnAssignedPort(app).then(
  (server) => {
    log.info("identities.listening", { port: assignedPort() });
    // Matches the session service: drain in-flight requests before exiting.
    setupGracefulShutdown(server, log);
  },
  (err) => {
    log.error("identities.listen_failed", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  },
);
