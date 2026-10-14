import type { Command } from "commander";
import type { BarryClient } from "@barry-rocks/sdk/internal/client";
import { PairingCodeSchema, PairingGrantSchema, DeviceIdSchema } from "@barry-rocks/sdk/internal/auth";

type DeviceOperations = Pick<BarryClient["devices"], "pending" | "authorize" | "list" | "revoke">;
export interface DeviceCommandDeps {
  api(): Promise<DeviceOperations>;
  write(line: string): void;
  interactive: boolean;
  choose(choices: { name: string; value: string }[]): Promise<string>;
  confirm(message: string): Promise<boolean>;
  now(): number;
}
export interface PairDeviceOptions { yes?: boolean; reject?: boolean; scopes?: string; identities?: string; expiresIn?: string }

const defaults: DeviceCommandDeps = {
  async api() {
    const [{ BarryClient }, { readServiceRegistry }, { installationSecrets }] = await Promise.all([
      import("@barry-rocks/sdk/internal/client"), import("@barry-rocks/sdk/services"), import("@barry-rocks/sdk/internal/services"),
    ]);
    const url = readServiceRegistry().resources["identities.identities"]?.url;
    if (!url) throw new Error("Identities service is not registered; run barry up before managing devices");
    const client = new BarryClient({ baseUrl: url, identities: { baseUrl: url, resolveCredential: async () => {
      const secret = (await installationSecrets(["BARRY_SECRET"], { allowUnconfiguredInstance: true })).BARRY_SECRET;
      if (!secret) throw new Error("Installation credential unavailable");
      return secret;
    } } });
    return client.devices;
  },
  write: line => console.log(line),
  get interactive() { return Boolean(process.stdin.isTTY && process.stdout.isTTY); },
  async choose(choices) { return (await import("@inquirer/prompts")).select({ message: "Select a pairing request", choices }); },
  async confirm(message) { return (await import("@inquirer/prompts")).confirm({ message, default: false }); },
  now: Date.now,
};

function time(value: number | null): string {
  if (value === null) return "never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}
function minutes(value?: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 525_600) {
    throw new Error("--expires-in must be a whole number from 1 to 525600 minutes");
  }
  return Number(value);
}
function values(value: string): string[] { return value.split(",").map(part => part.trim()); }

export async function pairDevice(deps: DeviceCommandDeps, code?: string, options: PairDeviceOptions = {}): Promise<void> {
  if (code !== undefined && !PairingCodeSchema.safeParse(code).success) throw new Error("Pairing code must be six digits, optionally formatted XXX-XXX");
  if (options.reject && [options.scopes, options.identities, options.expiresIn].some(value => value !== undefined)) throw new Error("Rejection cannot include an approval grant");
  const expiryMinutes = minutes(options.expiresIn);
  if (!deps.interactive && (!options.yes || code === undefined)) throw new Error("Unattended pairing requires an explicit code and --yes");
  const api = await deps.api();
  const requests = await api.pending();
  if (requests.length === 0 && code === undefined) { deps.write("No pending pairing requests."); return; }
  const selectedCode = code ?? await deps.choose(requests.map(request => ({
    name: `${request.pairingCode} — ${JSON.stringify(request.clientName)} — expires ${time(request.expiresAt)}`, value: request.pairingCode,
  })));
  const requested = requests.find(request => request.pairingCode.replace("-", "") === selectedCode.replace("-", ""));
  if (!requested || requested.expiresAt <= deps.now()) throw new Error("Pairing request is unavailable or expired; request a new code");
  const ids = options.identities === undefined ? requested.requestedIdentityIds : values(options.identities).map(id => /^[1-9]\d*$/.test(id) ? Number(id) : NaN);
  const grant = options.reject ? null : PairingGrantSchema.safeParse({
    scopes: options.scopes === undefined ? requested.requestedScopes : values(options.scopes), identityIds: ids,
  });
  if (grant !== null && !grant.success) throw new Error("Invalid device grant: use unique catalog scopes and positive canonical identity IDs");
  if (grant?.success && (grant.data.scopes.some(scope => !requested.requestedScopes.includes(scope)) || grant.data.identityIds.some(id => !requested.requestedIdentityIds.includes(id)))) {
    throw new Error("Approval can only reduce the requested scopes and identities");
  }
  deps.write(`Device: ${JSON.stringify(requested.clientName)}`);
  deps.write(`Requested scopes: ${requested.requestedScopes.join(", ")}`);
  deps.write(`Requested identities: ${requested.requestedIdentityIds.join(", ")}`);
  deps.write(`Pairing expires: ${time(requested.expiresAt)}`);
  if (grant?.success) {
    deps.write(`Approve scopes: ${grant.data.scopes.join(", ")}`);
    deps.write(`Approve identities: ${grant.data.identityIds.join(", ")}`);
    if (expiryMinutes !== undefined) deps.write(`Credential expires ${expiryMinutes} minutes after approval`);
  }
  if (!options.yes && !await deps.confirm(options.reject ? "Reject this pairing request?" : "Authorize this device with the displayed grant?")) {
    deps.write("No changes made."); return;
  }
  const approved = grant?.success ? { ...grant.data, ...(expiryMinutes === undefined ? {} : { expiresAt: deps.now() + expiryMinutes * 60_000 }) } : null;
  const outcome = await api.authorize(requested.pairingCode, approved);
  deps.write(`${outcome.status === "authorized" ? "Authorized" : "Rejected"} ${JSON.stringify(outcome.clientName)}.`);
}

export async function listDevices(deps: DeviceCommandDeps, json = false): Promise<void> {
  const records = await (await deps.api()).list();
  if (json) { deps.write(JSON.stringify({ devices: records }, null, 2)); return; }
  if (records.length === 0) { deps.write("No devices paired."); return; }
  for (const device of records) {
    const expired = (device.expiresAt !== null && device.expiresAt <= deps.now()) || (device.firstUsedAt === null && device.unusedExpiresAt <= deps.now());
    const state = device.revokedAt !== null ? "revoked" : expired ? "expired" : device.firstUsedAt === null ? "unused" : "active";
    deps.write(`${device.id}  ${JSON.stringify(device.name)}  ${state}`);
    deps.write(`  prefix ${device.tokenPrefix}…; scopes ${device.scopes.join(", ")}; identities ${device.identityIds.join(", ")}`);
    deps.write(`  created ${time(device.createdAt)}; last used ${time(device.lastUsedAt)}; expires ${device.expiresAt === null ? "no explicit expiry" : time(device.expiresAt)}`);
    if (device.firstUsedAt === null) deps.write(`  unused credential expires ${time(device.unusedExpiresAt)}`);
  }
}

export async function revokeDevice(deps: DeviceCommandDeps, id: string, yes = false): Promise<void> {
  if (!DeviceIdSchema.safeParse(id).success) throw new Error("Invalid device ID; use barry device list");
  if (!deps.interactive && !yes) throw new Error("Unattended revocation requires --yes");
  const api = await deps.api();
  const device = (await api.list()).find(device => device.id === id);
  if (!device) throw new Error("Device is unavailable or belongs to another operator");
  if (!yes && !await deps.confirm(`Revoke ${JSON.stringify(device.name)} (${device.id})?`)) { deps.write("No changes made."); return; }
  await api.revoke(id);
  deps.write(`Revoked ${device.id}. New authenticated requests will be refused.`);
}

export function registerDevices(program: Command, deps: DeviceCommandDeps = defaults): void {
  const device = program.command("device").description("Review pairing requests and manage scoped device credentials");
  device.command("pair [code]").description("Approve or reject a pending device after reviewing its grant")
    .option("--scopes <scopes>", "Comma-separated approved scopes; defaults to those requested")
    .option("--identities <ids>", "Comma-separated canonical identity IDs; defaults to those requested")
    .option("--expires-in <minutes>", "Expire the credential after 1–525600 minutes")
    .option("--reject", "Reject the pending request")
    .option("--yes", "Apply the displayed decision without an interactive confirmation")
    .action((code: string | undefined, options: PairDeviceOptions) => pairDevice(deps, code, options));
  device.command("list").description("List safe device metadata, grants and usage")
    .option("--json", "Print metadata as JSON")
    .action((options: { json?: boolean }) => listDevices(deps, options.json));
  device.command("revoke <id>").description("Revoke a device credential")
    .option("--yes", "Revoke without an interactive confirmation")
    .action((id: string, options: { yes?: boolean }) => revokeDevice(deps, id, options.yes));
}
