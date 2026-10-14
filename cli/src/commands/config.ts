import { getHostingConfig, barryAppSupportDir, barryCacheDir, barryConfigDir, barryEnvPath, barryLogsDir, instanceEnvValue, serviceRegistryPath, hostingPolicyPath } from "@barry-rocks/sdk/services";





/** `barry config`: where this instance lives and what it enforces. Never prints a secret. */
export function configCommand(): void {
  const hosting = getHostingConfig();

  console.log("Barry instance\n");
  console.log(`  Home:              ${process.env.BARRY_HOME || "(the installed instance)"}`);
  console.log(`  Data:              ${barryAppSupportDir()}`);
  console.log(`  Cache:             ${barryCacheDir()}`);
  console.log(`  Logs:              ${barryLogsDir()}`);
  console.log(`  Settings you edit: ${barryConfigDir()}`);
  console.log(`  Secrets file:      ${barryEnvPath()}`);
  console.log(`  Service registry:  ${serviceRegistryPath()}`);
  console.log(`  Hosting policy:    ${hostingPolicyPath()}`);
  console.log();

  console.log("Security");
  console.log(`  BARRY_SECRET set:  ${instanceEnvValue("BARRY_SECRET") ? "yes" : "no — run `barry setup`"}`);
  console.log("  Every request must carry the secret; no address is trusted.");
  console.log(`  CORS origins:      ${hosting.allowedOrigins.length ? hosting.allowedOrigins.join(", ") : "localhost only (BARRY_CORS_ORIGINS)"}`);
  console.log();
}
