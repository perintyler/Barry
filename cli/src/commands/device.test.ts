import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { pairDevice, listDevices, revokeDevice, registerDevices, type DeviceCommandDeps } from "./device.js";
import { applyCommandScope } from "../scope.js";

const id = "device_12345678-1234-1234-1234-123456789abc";
const now = 1_000_000;
const pending = { requestId: "pair_fixture", pairingCode: "123-456", clientName: "Fixture phone",
  requestedScopes: ["sessions:read", "sessions:turn"] as const, requestedIdentityIds: [1, 3], expiresAt: now + 300_000 };
const record = { id, name: "Fixture phone", actorId: 1, tokenPrefix: "barry_dt_abcdefgh", scopes: ["sessions:read"] as const,
  identityIds: [1], createdAt: now, unusedExpiresAt: now + 600_000, firstUsedAt: null, lastUsedAt: null, expiresAt: null, revokedAt: null };
function fixture() {
  const api = { pending: vi.fn(async () => [pending]), authorize: vi.fn(async (_code: string, grant: unknown) => ({ status: grant === null ? "rejected" as const : "authorized" as const, clientName: "Fixture phone" })),
    list: vi.fn(async () => [record]), revoke: vi.fn(async (_id: string) => {}) };
  const lines: string[] = [];
  const deps: DeviceCommandDeps = { api: vi.fn(async () => api), write: line => lines.push(line), interactive: true,
    choose: vi.fn(async () => "123-456"), confirm: vi.fn(async () => true), now: () => now };
  return { api, lines, deps };
}

describe("system device commands", () => {
  it("reviews the requested and reduced grants before authenticated approval", async () => {
    const { api, lines, deps } = fixture();
    await pairDevice(deps, "123456", { scopes: "sessions:read", identities: "1", expiresIn: "60" });
    expect(api.authorize).toHaveBeenCalledExactlyOnceWith("123-456", { scopes: ["sessions:read"], identityIds: [1], expiresAt: now + 3_600_000 });
    expect(lines.join("\n")).toContain("Requested identities: 1, 3");
    expect(lines.join("\n")).toContain("Approve identities: 1");
    expect(lines.at(-1)).toBe('Authorized "Fixture phone".');
    expect(deps.confirm).toHaveBeenCalledOnce();
  });

  it("does not approve when the user declines", async () => {
    const { api, deps, lines } = fixture();
    deps.confirm = vi.fn(async () => false);
    await pairDevice(deps, "123-456");
    expect(api.authorize).not.toHaveBeenCalled();
    expect(lines.at(-1)).toBe("No changes made.");
  });

  it("selects a request interactively without guessing from pending order", async () => {
    const { api, deps } = fixture();
    await pairDevice(deps);
    expect(deps.choose).toHaveBeenCalledOnce();
    expect(api.authorize).toHaveBeenCalledWith("123-456", { scopes: ["sessions:read", "sessions:turn"], identityIds: [1, 3] });
  });

  it("fails unattended pairing without both explicit decision and explicit code", async () => {
    const { api, deps } = fixture();
    deps.interactive = false;
    await expect(pairDevice(deps, "123-456")).rejects.toThrow("--yes");
    await expect(pairDevice(deps, undefined, { yes: true })).rejects.toThrow("explicit code");
    expect(api.pending).not.toHaveBeenCalled();
    await pairDevice(deps, "123-456", { yes: true });
    expect(api.authorize).toHaveBeenCalledOnce();
    expect(deps.confirm).not.toHaveBeenCalled();
  });

  it("rejects explicitly without attaching a grant", async () => {
    const { api, deps, lines } = fixture();
    await pairDevice(deps, "123-456", { reject: true, yes: true });
    expect(api.authorize).toHaveBeenCalledExactlyOnceWith("123-456", null);
    expect(lines.at(-1)).toBe('Rejected "Fixture phone".');
    await expect(pairDevice(deps, "123-456", { reject: true, scopes: "sessions:read" })).rejects.toThrow("Rejection cannot include");
  });

  it("refuses scope/identity expansion and malformed or duplicate grants", async () => {
    const { api, deps } = fixture();
    for (const options of [{ scopes: "tools:invoke" }, { identities: "2" }, { scopes: "admin" }, { scopes: "sessions:read,sessions:read" }, { identities: "1,1" }, { identities: "1e0" }, { identities: "0" }, { scopes: "" }]) {
      await expect(pairDevice(deps, "123-456", options)).rejects.toThrow();
    }
    expect(api.authorize).not.toHaveBeenCalled();
    expect(deps.confirm).not.toHaveBeenCalled();
  });

  it("refuses stale/missing requests and a stale interactive selection", async () => {
    const { api, deps } = fixture();
    await expect(pairDevice(deps, "999-999", { yes: true })).rejects.toThrow("unavailable");
    deps.now = () => pending.expiresAt;
    await expect(pairDevice(deps, "123-456", { yes: true })).rejects.toThrow("expired");
    deps.choose = vi.fn(async () => "999-999");
    await expect(pairDevice(deps)).rejects.toThrow("unavailable");
    expect(api.authorize).not.toHaveBeenCalled();
  });

  it("handles an empty pending list without prompting or approving", async () => {
    const { api, deps, lines } = fixture();
    api.pending.mockResolvedValue([]);
    await pairDevice(deps);
    expect(lines).toEqual(["No pending pairing requests."]);
    expect(deps.choose).not.toHaveBeenCalled();
    await expect(pairDevice(deps, "123-456", { yes: true })).rejects.toThrow("unavailable");
    expect(api.authorize).not.toHaveBeenCalled();
  });

  it("computes optional credential expiry after interactive confirmation", async () => {
    const { api, deps } = fixture();
    deps.confirm = vi.fn(async () => { deps.now = () => now + 10_000; return true; });
    await pairDevice(deps, "123-456", { expiresIn: "1" });
    expect(api.authorize.mock.calls[0][1]).toMatchObject({ expiresAt: now + 70_000 });
  });

  it("rejects malformed code or expiry before opening the API", async () => {
    const { deps } = fixture();
    await expect(pairDevice(deps, "not-a-code")).rejects.toThrow("six digits");
    for (const expiresIn of ["0", "1.5", "-1", "525601", "Infinity", "1e2"]) await expect(pairDevice(deps, "123-456", { expiresIn })).rejects.toThrow("--expires-in");
    expect(deps.api).not.toHaveBeenCalled();
  });

  it("never prints a successful decision if approval fails or expires on the server", async () => {
    const { api, deps, lines } = fixture();
    api.authorize.mockRejectedValue(new Error("pairing expired"));
    await expect(pairDevice(deps, "123-456", { yes: true })).rejects.toThrow("pairing expired");
    expect(lines.some(line => line.startsWith("Authorized"))).toBe(false);
  });

  it("shows safe metadata and unused credential expiry", async () => {
    const { deps, lines } = fixture();
    deps.now = () => record.unusedExpiresAt;
    await listDevices(deps);
    expect(lines[0]).toContain("expired");
    expect(lines.join("\n")).toContain("unused credential expires");
    const jsonFixture = fixture();
    await listDevices(jsonFixture.deps, true);
    expect(JSON.parse(jsonFixture.lines[0])).toEqual({ devices: [record] });
  });

  it("reports no devices explicitly", async () => {
    const { api, deps, lines } = fixture();
    api.list.mockResolvedValue([]);
    await listDevices(deps);
    expect(lines).toEqual(["No devices paired."]);
  });

  it("revokes only a listed device after consent and never reports a failed revoke as success", async () => {
    const { api, deps, lines } = fixture();
    deps.confirm = vi.fn(async () => false);
    await revokeDevice(deps, id);
    expect(api.revoke).not.toHaveBeenCalled();
    await revokeDevice(deps, id, true);
    expect(api.revoke).toHaveBeenCalledExactlyOnceWith(id);
    api.revoke.mockRejectedValue(new Error("revocation failed"));
    lines.length = 0;
    await expect(revokeDevice(deps, id, true)).rejects.toThrow("revocation failed");
    expect(lines).toEqual([]);
  });

  it("refuses foreign IDs and unattended revocation without a decision", async () => {
    const { api, deps } = fixture();
    deps.interactive = false;
    await expect(revokeDevice(deps, id)).rejects.toThrow("--yes");
    expect(api.list).not.toHaveBeenCalled();
    await expect(revokeDevice(deps, "../identities", true)).rejects.toThrow("Invalid device ID");
    api.list.mockResolvedValue([]);
    await expect(revokeDevice(deps, id, true)).rejects.toThrow("another operator");
    expect(api.revoke).not.toHaveBeenCalled();
  });

  it("registers actual Commander flags and keeps device administration out of identity CLIs", async () => {
    const { api, deps } = fixture();
    const root = new Command().exitOverride();
    registerDevices(root, deps);
    await root.parseAsync(["device", "pair", "123-456", "--yes", "--scopes", "sessions:read", "--identities", "1"], { from: "user" });
    expect(api.authorize).toHaveBeenCalledExactlyOnceWith("123-456", { scopes: ["sessions:read"], identityIds: [1] });
    applyCommandScope(root, { kind: "identity", name: "fixture", binding: { id: 1, home: null } });
    expect(root.commands).toEqual([]);
    const system = new Command();
    registerDevices(system, deps);
    applyCommandScope(system, { kind: "system" });
    expect(system.commands.map(command => command.name())).toEqual(["device"]);
  });
});
