import { parseManifest } from "@barry-rocks/sdk/bags";
/**
 * The shipped harnesses as their records say, and the vendor catalog the
 * API installs at boot — what routing and the egress check read.
 *
 * The fields a route or a session turns on are copied from the adapters (their
 * vendor, whether Barry can point them at another endpoint, what they do
 * without a key, how they take a system prompt and skills, whether they can
 * deny tools, whether their hosted mode holds the egress proxy);
 * `shipped-harnesses.test.ts` holds each copy to the real adapter's record.
 */
import { shippedVendors } from "./shipped-vendors.js";

const VENDORS = await shippedVendors();
import { findInstalled, type HarnessCapabilities, type InstalledAdapter, type Mode } from "@barry-rocks/sdk/adapters/harnesses";
import { createModels, installModels } from "@barry-rocks/sdk/adapters/models";
import { setAgentRuntime } from "../agent-runtime.js";
import type { CreateSessionFn, RunStructuredFn } from "../agent-runtime-types.js";
import { installedAdapter } from "./installed-adapter.js";

import { nativeToolDenials } from "@barry-rocks/sdk/bounds";

function hosted(egressSandbox: boolean, gating: Mode["guarantees"]["gating"] = "static"): Mode {
  return {
    guarantees: { capture: "total", delivery: "wake", steer: false, interrupt: true, gating, keepsVendorUi: false, identity: "inherent" },
    verifiedOn: "0.0.0",
    evidence: { check: "test", proves: "test" },
    egressSandbox,
  };
}

function harness(
  id: string,
  vendor: string | undefined,
  capabilities: Pick<HarnessCapabilities, "endpoint" | "withoutKey" | "toolDenial" | "systemPromptFormat" | "skillsMount">,
  egressSandbox: boolean,
  aliases: string[] = [],
): InstalledAdapter {
  const base = installedAdapter(id);
  const directory = new URL(`../../../../../adapters/sessions/${id === "claude-code" ? "claude" : id}`, import.meta.url).pathname;
  const manifest = parseManifest(directory)!;
  const tools = [
    ...new Set(
      Object.values(manifest.bounds ?? {}).flatMap((entry) =>
        nativeToolDenials(entry.bound, id, undefined, aliases),
      ),
    ),
  ];
  return installedAdapter(id, {
    bag: { path: directory, manifest },
    tools,
    ...(aliases.length ? { aliases } : {}),
    ...(vendor ? { vendor } : {}),
    capabilities: { ...base.capabilities, ...capabilities },
    modes: { hosted: hosted(egressSandbox, id === "antigravity" || id === "codex" ? "hooks" : "per-call"), instrumented: null, guest: hosted(false) },
  });
}

export const SHIPPED_HARNESSES: Readonly<Record<string, InstalledAdapter>> = {
  antigravity: harness("antigravity", "google", { endpoint: "fixed", withoutKey: "unauthenticated", toolDenial: "native", systemPromptFormat: "raw", skillsMount: "plugin" }, false, ["agy"]),
  "claude-code": harness("claude-code", "anthropic", { endpoint: "configurable", withoutKey: "unauthenticated", toolDenial: "native", systemPromptFormat: "preset-append", skillsMount: "plugin" }, true, ["claude"]),
  codex: harness("codex", "openai", { endpoint: "configurable", withoutKey: "unauthenticated", toolDenial: "native", systemPromptFormat: "raw", skillsMount: "none" }, false),
  cursor: harness("cursor", "cursor", { endpoint: "fixed", withoutKey: "unauthenticated", toolDenial: "native", systemPromptFormat: "raw", skillsMount: "plugin" }, false),
  opencode: harness("opencode", undefined, { endpoint: "fixed", withoutKey: "unauthenticated", toolDenial: "native", systemPromptFormat: "unsupported", skillsMount: "none" }, false),
  pi: harness("pi", undefined, { endpoint: "configurable", withoutKey: "unauthenticated", toolDenial: "native", systemPromptFormat: "preset-append", skillsMount: "plugin" }, false),
};

/** By id or alias, as the API's own describer answers. */
export const describeShipped = (id: string): InstalledAdapter | undefined => findInstalled(Object.values(SHIPPED_HARNESSES), id);

/** Install the vendor catalog and the shipped records, as the API's boot does. */
export function wireShippedHarnesses(runtime: { createSession: CreateSessionFn; runStructured: RunStructuredFn }): void {
  installModels(createModels(VENDORS));
  setAgentRuntime({ ...runtime, describeAdapter: describeShipped });
}
