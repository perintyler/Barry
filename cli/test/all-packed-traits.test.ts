import { describe, expect, it } from "vitest";
import { traits } from "@barry-rocks/identities-bag";
import { baseIdentitySelection } from "@barry-rocks/sdk/internal/bags";
import { allPackedTraits } from "../src/commands/start.js";
import { prepareBagRegistry } from "../src/services/barry.js";

describe("all packed trait selection", () => {
  it("grants shipped tool bags while excluding service-only bags", async () => {
    await prepareBagRegistry();
    const bags = baseIdentitySelection().bags;
    const selected = await allPackedTraits(bags);
    expect(selected).toEqual(expect.arrayContaining(["filesystem", "bash", "telemetry"]));
    expect(selected).not.toContain("identities");
    const available = new Set((await traits.installed(bags)).map(trait => trait.name));
    expect(selected.every(name => available.has(name))).toBe(true);
    expect(selected).not.toContain("sessions/search");
  });

  it("refuses an unavailable packed bag instead of silently dropping its grant", async () => {
    await expect(allPackedTraits(["missing-packed-bag"])).rejects.toThrow(/Unknown bags/);
  });
});
