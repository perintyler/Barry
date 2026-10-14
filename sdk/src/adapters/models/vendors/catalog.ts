/**
 * Parse vendor catalogs as data without importing call implementations; reject duplicate model IDs and role defaults before a composition root assembles vendors.
 * See docs/decisions/0011-sdk-runtime-invariants.md for the retained rationale.
 */
import { z } from "zod";
import { parse } from "yaml";
import type { VendorId } from "../../../ids.js";
import type { Check } from "../../../services/checks.js";
import type { CompletionModel, DecisionModel, EmbeddingModel } from "../kinds.js";
import type { Endpoint, ListedModel, Vendor } from "./index.js";

const BaseUrl = z.union([
  z.string().min(1),
  z.strictObject({
    env: z.string().min(1).optional(),
    fallback: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
  }),
]);

const Model = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["completion", "embedding", "decision"]),
  roles: z.array(z.enum(["default", "small"])).optional(),
  /** A caveat shown in pickers — e.g. a measured failure at tool calling. */
  note: z.string().min(1).optional(),
  local: z.boolean().optional(),
  dimensions: z.number().int().positive().optional(),
  structuredOutput: z.enum(["native", "prompted"]).optional(),
});

const VendorEntry = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  /** Absent for a vendor Barry never calls directly (cursor serves only through its harness). */
  baseUrl: BaseUrl.optional(),
  credential: z.union([
    /**
     * The env var holding this vendor's key, with an optional default vault
     * item: when the identity does not define the variable itself, the gate
     * reads `item.field` from the identity's vault. The env-only form still
     * works — the identity must define the variable — and the checker warns
     * on it, because it pushes configuration onto every identity.
     */
    z.strictObject({
      env: z.string().min(1),
      item: z.string().min(1).optional(),
      field: z.enum(["username", "password", "notes", "uri"]).optional(),
    }),
    z.strictObject({ placeholder: z.string().min(1) }),
    z.null(),
  ]),
  compatible: z.array(z.strictObject({
    with: z.string().min(1),
    baseUrl: BaseUrl,
    structuredOutput: z.enum(["native", "prompted"]).optional(),
    egressSandbox: z.boolean().optional(),
  })).optional(),
  models: z.array(Model).min(1),
});

export const VendorCatalogSchema = z.array(VendorEntry).min(1);
const Catalog = z.strictObject({ vendors: VendorCatalogSchema });

function issuesOf(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

/**
 * Parse a legacy standalone catalog. Refuses, by name: an unknown or misspelled key
 * (the schema is strict — a typo'd field must not parse as absence), a model
 * id twice in one vendor, two `default` models of a kind, and a compatibility
 * door naming a vendor the file does not list.
 */
export function parseVendorCatalog(text: string): Vendor[] {
  const parsed = Catalog.safeParse(parse(text));
  if (!parsed.success) throw new Error(`vendors.yaml is not a valid catalog: ${issuesOf(parsed.error)}`);
  return validateVendorCatalog(parsed.data.vendors);
}

/** Validate catalog relationships independently of its containing file. */
export function validateVendorCatalog(vendors: Vendor[], checkCompatibility = true): Vendor[] {

  const ids = new Set<string>();
  for (const vendor of vendors) {
    if (ids.has(vendor.id)) throw new Error(`catalog lists vendor "${vendor.id}" twice`);
    ids.add(vendor.id);
  }
  for (const vendor of vendors) {
    const models = new Set<string>();
    const roles = new Set<string>();
    for (const model of vendor.models) {
      if (models.has(model.id)) throw new Error(`vendor ${vendor.id} lists model "${model.id}" twice`);
      models.add(model.id);
      for (const role of model.roles ?? []) {
        const key = `${model.kind}:${role}`;
        if (roles.has(key)) throw new Error(`vendor ${vendor.id} has two ${role} ${model.kind} models`);
        roles.add(key);
      }
    }
    for (const door of vendor.compatible ?? []) {
      if (checkCompatibility && !ids.has(door.with)) {
        throw new Error(`vendor ${vendor.id} declares compatibility with "${door.with}", which the catalog does not list`);
      }
    }
  }
  return vendors;
}

/**
 * The per-kind call code, keyed by the vendor id it serves. What a kind
 * directory exports; what turns parsed catalog data into callable vendors.
 */
export interface VendorFactories {
  completion?: Partial<Record<VendorId, (model: string, endpoint: Endpoint) => CompletionModel>>;
  embedding?: Partial<Record<VendorId, (model: string, endpoint: Endpoint) => EmbeddingModel>>;
  decision?: Partial<Record<VendorId, (model: string, endpoint: Endpoint) => DecisionModel>>;
  listModels?: Partial<Record<VendorId, (endpoint: Endpoint) => Promise<ListedModel[]>>>;
  check?: Partial<Record<VendorId, (endpoint: Endpoint, model?: string) => Promise<Check[]>>>;
}

function mergeFactoryMaps<Factory>(kind: string, maps: (Partial<Record<VendorId, Factory>> | undefined)[]): Partial<Record<VendorId, Factory>> {
  const result: Partial<Record<VendorId, Factory>> = {};
  for (const map of maps) {
    for (const [vendor, factory] of Object.entries(map ?? {})) {
      if (factory === undefined) continue;
      if (Object.hasOwn(result, vendor)) throw new Error(`duplicate ${kind} factory for vendor ${vendor}`);
      result[vendor] = factory;
    }
  }
  return result;
}

/** Compose independently installed providers without silently replacing one. */
export function mergeVendorFactories(...sources: VendorFactories[]): VendorFactories {
  return {
    completion: mergeFactoryMaps("completion", sources.map(source => source.completion)),
    decision: mergeFactoryMaps("decision", sources.map(source => source.decision)),
    embedding: mergeFactoryMaps("embedding", sources.map(source => source.embedding)),
    listModels: mergeFactoryMaps("listModels", sources.map(source => source.listModels)),
    check: mergeFactoryMaps("check", sources.map(source => source.check)),
  };
}

/**
 * The vendor call code an adapter package may ship beside its adapter.
 *
 * A harness adapter owns a session model; a vendor-carrying adapter also owns
 * call code for vendors Barry does not ship — its own rows and the factories
 * that serve them, installed and recorded like the adapter itself. The rows
 * are snapshotted into the installed record, so the catalog a picker reads
 * costs no imports; the factories load when the process that hosts models
 * asks for them.
 */
export interface VendorCode {
  vendors: Vendor[];
  factories: VendorFactories;
}

/**
 * Give a vendor-code literal its type, and refuse incoherence by name: a
 * factory keyed by a vendor this code does not declare would dangle forever —
 * no row, so no ref can ever reach it — and the moment to learn that is the
 * install, not the first call.
 */
export function defineVendorCode(code: VendorCode): VendorCode {
  if (!code || typeof code !== "object" || !Array.isArray(code.vendors) || !code.factories || typeof code.factories !== "object" || Array.isArray(code.factories)) {
    throw new Error("vendor code must declare catalog rows and factory maps");
  }
  if (!VendorCatalogSchema.safeParse(code.vendors).success) throw new Error("vendor code has an invalid catalog");
  const ids = new Set<string>();
  for (const vendor of code.vendors) {
    if (ids.has(vendor.id)) throw new Error(`vendor code lists vendor "${vendor.id}" twice`);
    ids.add(vendor.id);
  }
  for (const [kind, registry] of Object.entries(code.factories) as Array<[keyof VendorFactories, VendorFactories[keyof VendorFactories]]>) {
    if (!["completion", "decision", "embedding", "listModels", "check"].includes(kind) || !registry || typeof registry !== "object" || Array.isArray(registry)) {
      throw new Error(`vendor code has an invalid ${kind} factory map`);
    }
    for (const id of Object.keys(registry ?? {})) {
      if (!ids.has(id)) {
        throw new Error(`a ${kind} factory names vendor "${id}", which this vendor code does not declare`);
      }
      if (["__proto__", "constructor", "prototype"].includes(id) || typeof registry[id] !== "function") {
        throw new Error(`vendor code has an invalid ${kind} factory for ${id}`);
      }
    }
  }
  return code;
}

/**
 * Attach the call code to the catalog data.
 *
 * A factory keyed by a vendor the catalog does not list is refused rather
 * than silently dropped: a misspelled id would otherwise leave that vendor's
 * models unpickable-at and the failure would surface frames away from the
 * typo that caused it.
 */
export function assembleVendors(specs: readonly Vendor[], factories: VendorFactories): Vendor[] {
  for (const [kind, registry] of Object.entries(factories) as Array<[keyof VendorFactories, VendorFactories[keyof VendorFactories]]>) {
    for (const id of Object.keys(registry ?? {})) {
      if (!specs.some((vendor) => vendor.id === id)) {
        throw new Error(`a ${kind} factory names vendor "${id}", which the catalog does not list`);
      }
    }
  }
  return specs.map((vendor) => {
    const completion = factories.completion?.[vendor.id];
    const embedding = factories.embedding?.[vendor.id];
    const decision = factories.decision?.[vendor.id];
    const listModels = factories.listModels?.[vendor.id];
    const check = factories.check?.[vendor.id];
    if (!completion && !embedding && !decision && !listModels && !check) return vendor;
    return {
      ...vendor,
      ...(completion ? { completion } : {}),
      ...(embedding ? { embedding } : {}),
      ...(decision ? { decision } : {}),
      ...(listModels ? { listModels } : {}),
      ...(check ? { check } : {}),
    };
  });
}
