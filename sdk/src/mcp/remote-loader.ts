/**
 * Host entry points install remote discovery; bags depend on the loader's
 * injected seam rather than importing host transports. Registration is
 * idempotent, and local bags do not require remote discovery.
 */
import { setRemoteResourceDiscoverer } from "../bags/loader.js";
import { discoverRemoteBagResources } from "./remote.js";

let installed = false;

/** Remote bags load resource metadata through this optional discovery seam. */
export function installRemoteBagLoader(): void {
  if (installed) return;
  setRemoteResourceDiscoverer(discoverRemoteBagResources);
  installed = true;
}
