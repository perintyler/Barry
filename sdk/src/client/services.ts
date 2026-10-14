import type { Service } from "../barry/types.js";
import { servicesRoutes } from "../routes/services.js";
import { BarryApiError } from "./errors.js";
import type { ApiTransport, RequestOptions } from "./http.js";

export class Services {
  constructor(private readonly transport?: ApiTransport) {}
  private get http(): ApiTransport {
    if (!this.transport) throw new BarryApiError("Configure services.baseUrl and its credentials to use service control", { status: null, code: "service_unconfigured" });
    return this.transport;
  }
  async list(request: RequestOptions = {}): Promise<Service[]> {
    return (await this.http.call(servicesRoutes.listServices, {}, { timeoutMs: 30_000, ...request }))!.services;
  }
  async get(key: string, request: RequestOptions = {}): Promise<Service | null> {
    return (await this.http.call(servicesRoutes.getService, { params: { key } }, { timeoutMs: 30_000, ...request, notFound: "null" }))?.service ?? null;
  }
  async start(key: string, request: RequestOptions = {}): Promise<Service> {
    return (await this.http.call(servicesRoutes.startService, { params: { key } }, { timeoutMs: 120_000, ...request }))!.service;
  }
  async stop(key: string, request: RequestOptions = {}): Promise<Service> {
    return (await this.http.call(servicesRoutes.stopService, { params: { key } }, { timeoutMs: 120_000, ...request }))!.service;
  }
  async restart(key: string, request: RequestOptions = {}): Promise<Service> {
    return (await this.http.call(servicesRoutes.restartService, { params: { key } }, { timeoutMs: 120_000, ...request }))!.service;
  }
}
