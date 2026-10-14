import { describe, expect, it, vi } from "vitest";
import { BarryClient } from "./platypus.js";
import { PairingClaimSchema, PairingAuthorizeInputSchema, PairingRequestInputSchema } from "../auth/pairing.js";

const deviceId = "device_12345678-1234-1234-1234-123456789abc";
const pollToken = "barry_pr_" + "a".repeat(32);
const deviceToken = "barry_dt_" + "b".repeat(32);
const input = { clientName: "Fixture phone", requestedScopes: ["sessions:read"] as const, requestedIdentityIds: [1] };

describe("typed device client", () => {
  it("requires the identities endpoint without trying the sessions service", async () => {
    const fetch = vi.fn();
    const client = new BarryClient({ baseUrl: "https://sessions.example", fetch });
    await expect(client.devices.requestPairing(input)).rejects.toMatchObject({ code: "service_unconfigured" });
    await expect(client.devices.list()).rejects.toMatchObject({ code: "service_unconfigured" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("validates pairing input, poll credentials and device identifiers before HTTP", async () => {
    const fetch = vi.fn();
    const client = new BarryClient({ baseUrl: "https://sessions.example", identities: { baseUrl: "https://identities.example", fetch } });
    await expect(client.devices.requestPairing({ ...input, requestedIdentityIds: [1, 1] })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(client.devices.claimPairing("123-456")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(client.devices.authorize("bad-code", null)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(client.devices.revoke("../another-resource")).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps polling credentials in JSON bodies and does not forward session credentials", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ status: "pending" }), { status: 202, headers: { "Content-Type": "application/json" } }));
    const client = new BarryClient({ baseUrl: "https://sessions.example", secret: "root-session-secret", identities: { baseUrl: "https://identities.example", fetch } });
    expect(await client.devices.claimPairing(pollToken)).toEqual({ status: "pending" });
    const [url, options] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://identities.example/api/v1/devices/pair/claim");
    expect(new Headers(options!.headers).get("authorization")).toBeNull();
    expect(JSON.parse(options!.body as string)).toEqual({ pollToken });
  });

  it("rejects contradictory issuance and does not retry a lost or malformed claim response", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ status: "consumed", deviceId, deviceToken }), { headers: { "Content-Type": "application/json" } }));
    const client = new BarryClient({ baseUrl: "https://sessions.example", identities: { baseUrl: "https://identities.example", fetch } });
    const error = await client.devices.claimPairing(pollToken).catch(error => error);
    expect(error).toMatchObject({ code: "malformed_response" });
    expect(error.detail).toBeUndefined();
    expect(error.message).not.toContain(deviceToken);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retain echoed credentials in HTTP error messages, codes or details", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ title: deviceToken, detail: pollToken, error: deviceToken }), { status: 401 }));
    const client = new BarryClient({ baseUrl: "https://sessions.example", identities: { baseUrl: "https://identities.example", fetch } });
    const error = await client.devices.claimPairing(pollToken).catch(error => error);
    expect(error).toMatchObject({ status: 401, code: "http_401" });
    expect(error.detail).toBeUndefined();
    expect(error.message).not.toContain(deviceToken);
    expect(error.message).not.toContain(pollToken);
  });

  it("preserves pending and terminal claim states only at their specified HTTP statuses", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new BarryClient({ baseUrl: "https://sessions.example", identities: { baseUrl: "https://identities.example", fetch } });
    for (const [status, state] of [[202, "pending"], [403, "rejected"], [410, "expired"], [410, "consumed"]] as const) {
      fetch.mockResolvedValueOnce(new Response(JSON.stringify({ status: state }), { status }));
      expect(await client.devices.claimPairing(pollToken)).toEqual({ status: state });
    }
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ status: "pending" }), { status: 200 }));
    await expect(client.devices.claimPairing(pollToken)).rejects.toMatchObject({ code: "malformed_response", status: 200 });
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ status: "authorized", deviceId, deviceToken, scopes: ["sessions:read"], identityIds: [1] }), { status: 410 }));
    await expect(client.devices.claimPairing(pollToken)).rejects.toMatchObject({ code: "http_410" });
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ status: "pending" }), { status: 201 }));
    await expect(client.devices.claimPairing(pollToken)).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("bounds uncooperative credential resolution and never sends a late pairing mutation", async () => {
    const fetch = vi.fn();
    const client = new BarryClient({ baseUrl: "https://sessions.example", identities: { baseUrl: "https://identities.example", fetch, resolveCredential: () => new Promise<string>(() => {}) } });
    await expect(client.devices.authorize("123-456", null, { timeoutMs: 10 })).rejects.toMatchObject({ code: "timeout" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never accepts authority fields or root scopes in shared pairing contracts", () => {
    expect(PairingRequestInputSchema.safeParse({ ...input, actorId: 2 }).success).toBe(false);
    expect(PairingAuthorizeInputSchema.safeParse({ code: "123-456", actorId: 2, grant: null }).success).toBe(false);
    expect(PairingAuthorizeInputSchema.safeParse({ code: "123-456", grant: { scopes: ["admin"], identityIds: [1] } }).success).toBe(false);
    const claimed = PairingClaimSchema.parse({ status: "authorized", deviceId, deviceToken, scopes: ["sessions:read"], identityIds: [1] });
    if (claimed.status !== "authorized") throw new Error("Expected fixture claim");
    expect(Object.isFrozen(claimed.scopes)).toBe(true);
    expect(Object.isFrozen(claimed.identityIds)).toBe(true);
  });
});


it("uses the pairing declaration's creation status and request body", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ requestId: "request-1", pairingCode: "123-456", pollToken, expiresAt: 1_800_000_000_000, expiresIn: 300 }, { status: 201 }));
  const client = new BarryClient({ baseUrl: "https://sessions.example", identities: { baseUrl: "https://identities.example", fetch } });
  await client.devices.requestPairing(input);
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ clientName: input.clientName });
});
