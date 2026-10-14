import { devicesRoutes } from "../routes/devices.js";
import { type PairingInput, type PairingGrant, type PairingRequest, type PairingClaim, type DeviceRecord } from "../auth/pairing.js";
import { BarryApiError } from "./errors.js";
import type { ApiTransport, RequestOptions } from "./http.js";

export class Devices {
  constructor(private readonly transport?: ApiTransport) {}

  private get http(): ApiTransport {
    if (!this.transport) throw new BarryApiError("Configure identities.baseUrl to use device pairing", { status: null, code: "service_unconfigured" });
    return this.transport;
  }

  async requestPairing(input: PairingInput, request: RequestOptions = {}): Promise<PairingRequest> {
    const inputBody = input;
    return (await this.http.call(devicesRoutes.requestPairing, { body: inputBody }, { ...request }))!;
  }

  async claimPairing(pollToken: string, request: RequestOptions = {}): Promise<PairingClaim> {
    const inputBody = { pollToken };
    return (await this.http.call(devicesRoutes.claimPairing, { body: inputBody }, { ...request }))!;
  }

  async pending(request: RequestOptions = {}) {
    return (await this.http.call(devicesRoutes.pendingPairings, {}, { ...request }))!.requests;
  }

  async authorize(code: string, grant: PairingGrant | null, request: RequestOptions = {}) {
    const inputBody = { code, grant };
    return (await this.http.call(devicesRoutes.authorizePairing, { body: inputBody }, { ...request }))!;
  }

  async list(request: RequestOptions = {}): Promise<DeviceRecord[]> {
    return (await this.http.call(devicesRoutes.listDevices, {}, { ...request }))!.devices;
  }

  async revoke(id: string, request: RequestOptions = {}): Promise<void> {
    await this.http.call(devicesRoutes.revokeDevice, { params: { id } }, { ...request });
  }
}

export type { PairingInput, PairingGrant, PairingRequest, PairingClaim, DeviceRecord } from "../auth/pairing.js";
