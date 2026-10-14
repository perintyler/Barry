import { describe, it, expect } from "vitest";
import { parseManifest } from "../bags/manifest.js";
import { resolveNativePolicy, nativeToolsTakenBack } from "./native-policy.js";
import { resolveEffectiveBound } from "./effective-bound.js";
import { NATIVE_TOOLS } from "../../../adapters/sessions/claude/src/native-tools.js";

const manifest = parseManifest(new URL("../../../adapters/sessions/claude", import.meta.url).pathname)!;
const bash = parseManifest(new URL("../../../bags/bash", import.meta.url).pathname)!;
const harness = { id: "claude-code", nativeTools: NATIVE_TOOLS, bag: { path: "", manifest } };
const traits = Object.fromEntries([manifest, bash].flatMap((bag) => Object.entries(bag.traits).map(([name, trait]) => [name, { ...trait, name, namespaces: trait.bags, access: "read" as const }])));
const bounds = { ...manifest.bounds, ...bash.bounds };

describe("bash-owned trait reaches native policy", () => {
  it.each(["bash:no-bash"])("%s denies shell on both launch and hosted paths", async (selection) => {
    const bound = await resolveEffectiveBound({ traitNames: [selection], traits, harness: harness.id, boundByName: async (name) => bounds[name]?.bound });
    expect(nativeToolsTakenBack(bound, harness)).toEqual(["Bash", "PowerShell", "Monitor"]);
    expect(bound?.deniedTools).toEqual(["Bash", "BashOutput", "KillShell"]);
    expect(resolveNativePolicy({ bound, tools: [] }, harness, "guest").denied).toContain("Bash");
    expect(resolveNativePolicy({ bound, tools: [] }, harness, "hosted").denied).toContain("Bash");
  });
  it("keeps native shell blocked without selecting a restriction trait", async () => {
    const bound = await resolveEffectiveBound({ traitNames: [], traits, harness: harness.id, boundByName: async (name) => bounds[name]?.bound });
    expect(resolveNativePolicy({ bound, tools: [] }, harness, "guest").denied).toContain("Bash");
  });
});
