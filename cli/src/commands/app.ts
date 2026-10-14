/**
 * `barry app`: see and open GUI applications registered across this instance's bags.
 *
 * Apps register their capabilities, protocol versions, and URL schemes in bag.yaml,
 * allowing Barry to launch deep links and mediate app sessions over protocol v1.
 */
import { listApps, getAppUrl } from "@barry-rocks/sdk/services";
import { bold, dim } from "../lib/ansi.js";

export async function appListCommand(options: { json?: boolean } = {}): Promise<void> {
  const apps = listApps();
  if (options.json) {
    console.log(JSON.stringify(apps, null, 2));
    return;
  }
  if (apps.length === 0) {
    console.log("\n  No GUI apps registered on this instance.\n");
    return;
  }
  console.log();
  console.log(`  ${bold("Registered Apps")} ${dim(`(${apps.length})`)}`);
  console.log();
  for (const app of apps) {
    const title = app.displayName ? `${bold(app.displayName)} (${app.id ?? app.name})` : bold(app.id ?? app.name);
    const bagInfo = dim(`[${app.bag}]`);
    const version = app.protocolVersion !== undefined ? `v${app.protocolVersion}` : dim("unversioned");
    const caps = app.capabilities
      ? Object.entries(app.capabilities)
          .filter(([, enabled]) => enabled)
          .map(([k]) => k)
          .join(", ") || "none"
      : "none";
    const url = app.url ?? (app.urlSchemes?.length ? `${app.urlSchemes[0]}://` : dim("no url"));
    console.log(`  ${title} ${bagInfo}`);
    console.log(`    protocol: ${version}  capabilities: ${caps}`);
    console.log(`    url: ${url}`);
    console.log();
  }
}

export async function appUrlCommand(name: string, options: { session?: string } = {}): Promise<void> {
  const url = getAppUrl(name, options);
  console.log(url);
}
