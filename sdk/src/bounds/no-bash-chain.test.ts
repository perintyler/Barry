import { describe, it, expect } from "vitest";
import { parseManifest } from "../bags/manifest.js";
import { resolveNativeTools, nativeToolsTakenBack } from "./native-tools.js";
import { resolveBound } from "./resolve-bound.js";
import { NATIVE_TOOLS } from "../../../adapters/sessions/claude/src/native-tools.js";

const manifest = parseManifest(new URL("../../../adapters/sessions/claude", import.meta.url).pathname)!;
const bash = parseManifest(new URL("../../../bags/bash", import.meta.url).pathname)!;
const harness = { id: "claude-code", tools: NATIVE_TOOLS, bag: { path: "", manifest } };
const bounds = { ...manifest.bounds, ...bash.bounds };

describe("bash-owned bound reaches native tool resolution", () => {
  it.each(["bash:no-bash"])("%s denies shell on both launch and hosted paths", async (selection) => {
    const bound = await resolveBound({ bounds: [selection], harness: harness.id, boundByName: async (name) => bounds[name]?.bound ?? bounds[name.replace(/^bash:/, "")]?.bound });
    expect(nativeToolsTakenBack(bound, harness)).toEqual(["Bash", "PowerShell", "Monitor"]);
    expect(bound?.tools?.deny).toEqual(["bash"]);
    expect(resolveNativeTools({ bound, tools: [] }, harness, "guest").denied).toContain("Bash");
    expect(resolveNativeTools({ bound, tools: [] }, harness, "hosted").denied).toContain("Bash");
  });
});
