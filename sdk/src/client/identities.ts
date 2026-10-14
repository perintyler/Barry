import { identitiesRoutes } from "../routes/identities.js";
import { z } from "zod";
import { CreateIdentityRequestSchema, UpdateIdentityRequestSchema, IdentityResponseSchema, EffectiveIdentityResponseSchema, TraitListResponseSchema, AvailableBagsResponseSchema } from "../identities/types.js";
import { BoundListResponseSchema, UpdateBoundRequestSchema } from "../bounds/types.js";
import { BarryApiError } from "./errors.js";
import type { ApiTransport, RequestOptions } from "./http.js";

export type CreateIdentityInput = z.input<typeof CreateIdentityRequestSchema>;
export type UpdateIdentityInput = z.input<typeof UpdateIdentityRequestSchema>;
export type IdentityResult = z.infer<typeof IdentityResponseSchema>;
export type Identity = IdentityResult["identity"];
export type EffectiveIdentity = z.infer<typeof EffectiveIdentityResponseSchema>;

export class Identities {
  private readonly transport: ApiTransport | undefined;

  constructor(transport?: ApiTransport) { this.transport = transport; }

  private get http(): ApiTransport {
    if (!this.transport) throw new BarryApiError("Configure identities.baseUrl and its credentials to use the identities service", { status: null, code: "service_unconfigured" });
    return this.transport;
  }

  private reference(id: string | number): string {
    if (typeof id === "number" ? !Number.isSafeInteger(id) || id <= 0 : id.length === 0) throw new BarryApiError("Identity reference must be a name or a positive safe integer", { status: null, code: "invalid_request" });
    return String(id);
  }

  async list(request: RequestOptions = {}): Promise<Identity[]> {
    const result = await this.http.call(identitiesRoutes.listIdentities, {}, request);
    return result!.identities;
  }

  async get(id: string | number, request: RequestOptions = {}): Promise<Identity | null> {
    const result = await this.http.call(identitiesRoutes.getIdentity, { params: { identity: this.reference(id) } }, { ...request, notFound: "null" });
    return result?.identity ?? null;
  }

  async create(input: CreateIdentityInput, request: RequestOptions = {}): Promise<IdentityResult> {
    const inputBody = input;
    const result = await this.http.call(identitiesRoutes.createIdentity, { body: inputBody }, { ...request });
    return result!;
  }

  async update(id: string | number, input: UpdateIdentityInput, request: RequestOptions = {}): Promise<IdentityResult> {
    const inputBody = input;
    const result = await this.http.call(identitiesRoutes.updateIdentity, { params: { identity: this.reference(id) }, body: inputBody }, { ...request });
    return result!;
  }

  /** Delete an identity that has no directory; a directory identity is refused, as it is deleted from the terminal. */
  async remove(id: string | number, request: RequestOptions = {}): Promise<{ activeIdentity?: string | null }> {
    const result = await this.http.call(identitiesRoutes.deleteIdentity, { params: { identity: this.reference(id) } }, request);
    return { ...(result!.activeIdentity !== undefined ? { activeIdentity: result!.activeIdentity } : {}) };
  }

  /** Make an identity the owner's default. */
  async setDefault(id: string | number, request: RequestOptions = {}): Promise<void> {
    await this.http.call(identitiesRoutes.setActiveIdentity, { params: { identity: this.reference(id) } }, request);
  }

  /** Every trait this installation has. */
  async traits(request: RequestOptions = {}): Promise<z.infer<typeof TraitListResponseSchema>["traits"]> {
    const result = await this.http.call(identitiesRoutes.listTraits, {}, request);
    return result!.traits;
  }

  /** Every named bound this installation has. */
  async bounds(request: RequestOptions = {}): Promise<z.infer<typeof BoundListResponseSchema>["bounds"]> {
    const result = await this.http.call(identitiesRoutes.listBounds, {}, request);
    return result!.bounds;
  }

  async traitsOf(identity: string | number, request: RequestOptions = {}) {
    return (await this.http.call(identitiesRoutes.listIdentityTraits, { params: { identity: this.reference(identity) } }, request))!.traits;
  }

  async updateBound(name: string, changes: z.input<typeof UpdateBoundRequestSchema>, request: RequestOptions = {}) {
    return (await this.http.call(identitiesRoutes.updateBound, { params: { name }, body: changes }, request))!.bound;
  }

  /** Every bag the registry knows. */
  async bags(request: RequestOptions = {}): Promise<z.infer<typeof AvailableBagsResponseSchema>["bags"]> {
    const result = await this.http.call(identitiesRoutes.listAvailableBags, {}, request);
    return result!.bags;
  }

  async effective(options: { repoPath?: string } = {}, request: RequestOptions = {}): Promise<EffectiveIdentity> {
    const result = await this.http.call(identitiesRoutes.getEffectiveIdentity, { query: { ...options } }, { ...request });
    return result!;
  }
}
