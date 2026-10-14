import { describe, it, expect } from "vitest";
import { traits } from "@barry-rocks/identities-bag";
import { describeUnselectedServers } from "../src/commands/start.js";
import type { McpConfig } from "../src/config.js";

// Describe the selected grant mode accurately; mounted namespaces alone do not establish tool access.
// Rationale: docs/decisions/0010-adapter-and-session-regression-invariants.md#note-038
describe("describeUnselectedServers", () => {
  const config = (...names: string[]): McpConfig => ({
    mcpServers: Object.fromEntries(
      names.map((n) => [n, { type: "http" as const, url: `http://localhost/${n}` }]),
    ),
  });

  // The regression itself. `barry` is always-on; the rest ride in on identity
  // bags. The old string called this "always-on only" — the lie being fixed.
  it("names the identity-granted servers instead of calling them always-on", () => {
    const label = describeUnselectedServers(config("barry", "slack", "linear", "datadog"), "identity");

    expect(label).toContain("3");
    expect(label).toMatch(/bags/);
    // The specific false claim must not reappear in any form.
    expect(label).not.toBe("always-on only");
    expect(label).not.toMatch(/^always-on only/);
  });

  // The other direction, and the reason this helper took a parameter. Under
  // bag_grant: session those servers are mounted but their tools are NOT
  // granted, so claiming they came "from your barry's bags" would overclaim —
  // the same lie as the original, pointing the other way.
  it("says mounted-but-ungranted under bag_grant: session", () => {
    const label = describeUnselectedServers(config("barry", "slack", "linear", "datadog"), "session");

    expect(label).toContain("3");
    expect(label).toMatch(/ungranted/);
    expect(label).not.toMatch(/from your barry's bags/);
  });

  // The default must be the safe reading. A caller that has not been taught the
  // knob must not print the grant-implying wording.
  it("defaults to the session reading", () => {
    const config4 = config("barry", "slack", "linear", "datadog");
    expect(describeUnselectedServers(config4)).toBe(
      describeUnselectedServers(config4, "session"),
    );
  });

  // The honest case: nothing beyond the always-on seed. Here "always-on only"
  // is TRUE, so the label is allowed to say it.
  it("still says always-on only when that is actually true", () => {
    expect(describeUnselectedServers(config("barry"))).toContain("always-on only");
  });

  // Counts must track the real split, not a constant — in both modes.
  it("counts always-on and identity-granted separately", () => {
    const granted = describeUnselectedServers(config("barry", "slack"), "identity");
    expect(granted).toContain("1 always-on");
    expect(granted).toContain("1 from");

    const withheld = describeUnselectedServers(config("barry", "slack"), "session");
    expect(withheld).toContain("1 always-on");
    expect(withheld).toContain("1 mounted but ungranted");
  });

  // An empty config must not claim identity grants it does not have.
  it("reports always-on only for an empty config", () => {
    expect(describeUnselectedServers(config())).toContain("always-on only");
  });

  // Guards the helper's premise: it classifies by ALWAYS_ON_SERVERS membership,
  // so a server in that list is never miscounted as identity-granted. If this
  // list is ever emptied, the "always-on" half of the label becomes vacuous.
  it("classifies against the real ALWAYS_ON_SERVERS list", () => {
    expect(traits.alwaysOn).toContain("barry");
    expect(traits.alwaysOn).not.toContain("slack");
  });
});
