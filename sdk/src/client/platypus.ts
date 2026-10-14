import { Services } from "./services.js";
import { Identities } from "./identities.js";
import { Devices } from "./devices.js";
import { Actions } from "./actions.js";
import { Events } from "./events.js";
import { Schedules } from "./schedules.js";
import { Jobs } from "./jobs.js";
import { ApiTransport, type BarryClientOptions } from "./http.js";
import { Sessions } from "./sessions.js";

export { BarryApiError } from "./errors.js";
export type { BarryClientOptions, ServiceClientOptions, RequestOptions } from "./http.js";
export type { SessionListOptions, CreateSessionInput, UpdateSessionInput, CreateSessionResponse } from "./sessions.js";

/**
 * Barry service client for connecting to a running Barry instance.
 *
 *   const client = BarryClient.connect({ baseUrl: "https://barry.example", secret: token });
 *   await client.events.create({ type: "notification", title: "Done" });
 *
 * Construction only configures HTTP access — it contacts no services eagerly,
 * so one unavailable service never prevents others from being used.
 * Each call uses the supplied credential or invokes the supplied credential resolver.
 */
export class BarryClient {
  readonly identities: Identities;
  readonly services: Services;
  readonly devices: Devices;
  readonly sessions: Sessions;
  readonly events: Events;
  readonly actions: Actions;
  readonly schedules: Schedules;
  readonly jobs: Jobs;

  constructor(options: BarryClientOptions = {}) {
    const http = new ApiTransport(options);
    const identities = options.identities ? new ApiTransport(options.identities) : undefined;
    this.identities = new Identities(identities);
    this.services = new Services(options.services ? new ApiTransport(options.services) : undefined);
    this.devices = new Devices(identities);
    this.sessions = new Sessions(http);
    this.events = new Events(http);
    this.actions = new Actions(http);
    this.schedules = new Schedules(http);
    this.jobs = new Jobs(http);
  }

  static connect(options: BarryClientOptions = {}): BarryClient {
    return new BarryClient(options);
  }
}

export type { CredentialResolver, ClientCredentials } from "./credentials.js";

export type { CreateIdentityInput, UpdateIdentityInput, IdentityResult, Identity, EffectiveIdentity } from "./identities.js";
export type { PairingInput, PairingGrant, PairingRequest, PairingClaim, DeviceRecord } from "./devices.js";
