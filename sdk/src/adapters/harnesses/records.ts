import { validVersionPolicy } from "./versions.js";
import { z } from "zod";
import { isAbsolute, relative } from "node:path";
import { isHarnessId } from "../../ids.js";
import type { BagManifest } from "../../bags/types.js";
import { VendorModelsSchema } from "../models/vendors/models.js";
import type { InstalledAdapter } from "./index.js";

const nonempty = z.string().min(1);
const absolutePath = nonempty.refine(isAbsolute);
const id = nonempty.refine(isHarnessId);
const platform = z.enum(["aix", "android", "darwin", "freebsd", "haiku", "linux", "openbsd", "sunos", "win32", "cygwin", "netbsd"]);
const modeId = z.enum(["hosted", "instrumented", "guest"]);
const guarantees = z.strictObject({
  capture: z.enum(["total", "near-total", "post-hoc", "none"]),
  delivery: z.enum(["wake", "wake-peer-framed", "turn-end", "tool-call", "on-resume", "none"]),
  steer: z.boolean(), interrupt: z.boolean(),
  gating: z.enum(["per-call", "static", "hooks", "none"]),
  keepsVendorUi: z.boolean(), identity: z.enum(["inherent", "mcp-url", "hooks", "none"]),
});
const range = z.strictObject({ min: nonempty.optional(), max: nonempty.optional(), before: nonempty.optional() });
const versions = z.strictObject({
  recommendedVersion: nonempty,
  testedVersions: z.array(nonempty),
  supportedVersions: z.array(range),
  incompatibleVersions: z.array(z.strictObject({ range, reason: nonempty })).optional(),
}).refine(validVersionPolicy, "invalid version policy");
const mode = z.strictObject({
  native: z.strictObject({
    controllable: z.array(nonempty).optional(),
    grantable: z.array(nonempty).optional(),
    inseparable: z.array(z.array(nonempty)).optional(),
    uncontrolled: z.record(nonempty, nonempty).optional(),
    operatorOverride: nonempty.optional(),
  }).refine(n => Array.isArray(n.controllable) || Array.isArray(n.grantable), {
    message: "native control requires controllable or grantable",
  }).transform((n): import("./index.js").NativeControl => {
    const out = { ...n } as import("./index.js").NativeControl;
    if (out.controllable === undefined && out.grantable !== undefined) {
      Object.defineProperty(out, "controllable", { value: out.grantable, enumerable: false });
    }
    if (out.grantable === undefined && out.controllable !== undefined) {
      Object.defineProperty(out, "grantable", { value: out.controllable, enumerable: false });
    }
    return out;
  }).optional(),
  guarantees,
  verifiedOn: nonempty,
  versions: versions.optional(),
  build: z.enum(["binary", "bundled"]).optional(),
  evidence: z.strictObject({ check: nonempty, proves: nonempty }),
  egressSandbox: z.boolean(),
  approvalContinuation: z.enum(["durable", "live", "unsupported"]).optional(),
  platforms: z.array(platform).optional(),
  attachesTo: z.literal("hosted").optional(),
});
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const manifest = z.custom<BagManifest>(value => {
  if (!object(value) || typeof value.name !== "string" || !value.name || typeof value.description !== "string") return false;
  if (!["mcpServers", "services", "apps", "schedules", "scripts"].every(key => object(value[key]))) return false;
  return ["tools", "dependencies"].every(key => Array.isArray(value[key]));
}, "invalid normalized bag snapshot");

export const InstalledAdapterSchema = z.strictObject({
  id,
  packageName: nonempty,
  contractVersion: z.literal(1),
  bag: z.strictObject({ path: absolutePath, manifest }).optional(),
  aliases: z.array(id).refine(values => new Set(values).size === values.length).optional(),
  label: nonempty,
  experimental: nonempty.refine(value => value.trim().length > 0).optional(),
  vendor: nonempty.optional(),
  offeredModels: z.array(z.strictObject({ id: nonempty, label: nonempty })).optional(),
  requirements: z.strictObject({
    binary: z.strictObject({
      paths: z.array(absolutePath).optional(),
      overrideEnv: nonempty.optional(),
      command: nonempty, versionArgs: z.array(nonempty).min(1), versionPattern: nonempty,
      install: z.strictObject({ darwin: nonempty.optional(), linux: nonempty.optional(), fallback: nonempty.optional() }),
      recommendedVersion: nonempty.optional(),
      pin: z.strictObject({ version: nonempty, enforcedBy: nonempty }).optional(),
    }),
    platforms: z.array(platform).optional(),
  }),
  capabilities: z.strictObject({
    mcpTransports: z.array(z.enum(["stdio", "http", "sse"])),
    toolDenial: z.enum(["native", "none"]), systemPromptFormat: z.enum(["preset-append", "raw", "unsupported"]),
    skillsMount: z.enum(["plugin", "none"]), withoutKey: z.enum(["subscription-oauth", "unauthenticated"]),
    endpoint: z.enum(["configurable", "fixed"]),
  }),
  tools: z.array(nonempty).refine(values => new Set(values).size === values.length),
  defaultMode: modeId,
  modes: z.strictObject({ hosted: mode.nullable(), instrumented: mode.nullable(), guest: mode.nullable() }),
  vendorCode: z.strictObject({ vendors: VendorModelsSchema }).optional(),
  path: absolutePath,
  version: nonempty,
  installedAt: z.iso.datetime(),
}).superRefine((record, context) => {
  if (record.aliases?.includes(record.id)) context.addIssue({ code: "custom", message: "an adapter aliases itself", path: ["aliases"] });
  if (!record.modes[record.defaultMode]) context.addIssue({ code: "custom", message: "default mode is absent", path: ["defaultMode"] });
  if (record.bag && relative(record.path, record.bag.path).split(/[\\/]/).includes("..")) context.addIssue({ code: "custom", message: "bag snapshot escapes its package", path: ["bag", "path"] });
});

export function parseInstalledAdapters(value: unknown): InstalledAdapter[] {
  const parsed = z.array(InstalledAdapterSchema).parse(value);
  const names = new Set<string>();
  const packages = new Set<string>();
  const paths = new Set<string>();
  const vendors = new Set<string>();
  for (const record of parsed) {
    if (packages.has(record.packageName) || paths.has(record.path)) throw new Error("an adapter package is recorded twice");
    packages.add(record.packageName); paths.add(record.path);
    for (const name of [record.id, ...record.aliases ?? []]) {
      if (names.has(name)) throw new Error(`adapter name ${name} is claimed twice`);
      names.add(name);
    }
    for (const vendor of record.vendorCode?.vendors ?? []) {
      if (vendors.has(vendor.id)) throw new Error(`vendor ${vendor.id} is claimed twice`);
      vendors.add(vendor.id);
    }
  }
  // Normalize older registrations in memory; a subsequent registration writes the new form.
  for (const record of parsed) {
    record.requirements.binary.recommendedVersion ??= record.requirements.binary.pin?.version;
    delete record.requirements.binary.pin;
    for (const mode of Object.values(record.modes)) if (mode) mode.versions ??= {
      recommendedVersion: mode.verifiedOn, testedVersions: [mode.verifiedOn],
      supportedVersions: [{ min: mode.verifiedOn, max: mode.verifiedOn }],
    };
  }
  return parsed;
}
