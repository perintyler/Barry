import { describe, expect, it } from "vitest";
import { checkAdapter, testAdapter, type Adapter, type LaunchMode, type SessionMode } from "./index.js";

const guest = testAdapter().modes.guest as LaunchMode;

/** A bag manifest satisfying the credentials rule: one vault-item default. */
const withCredentials = {
  bagManifest: {
    credentials: { TEST_API_KEY: { source: "vault" as const, item: "test-api-key", field: "password" as const } },
  },
};

function hosted(overrides: Partial<SessionMode> = {}): SessionMode {
  return {
    guarantees: { ...guest.guarantees, capture: "total", interrupt: true, gating: "per-call" },
    verifiedOn: "1.2.3",
    evidence: { check: "acceptance/hosted.mjs", proves: "a fixture's claim" },
    egressSandbox: false,
    structuredOutput: "prompted",
    start: () => Promise.reject(new Error("not started in this test")),
    ...overrides,
  };
}

/**
 * A conforming adapter with some fields replaced by shapes the type forbids,
 * as a third party's plain JavaScript can produce.
 */
function malformed(fields: Record<string, unknown>): Adapter {
  return Object.assign(testAdapter(), fields);
}

describe("checkAdapter", () => {
  it("rejects malformed optional executable and discovery operations", () => {
    expect(checkAdapter(malformed({ resolveBinary: "cursor" })).problems).toContain("resolveBinary must be a function when provided");
    expect(checkAdapter(malformed({ listModels: [] })).problems).toContain("listModels must be a function when provided");
    expect(checkAdapter(testAdapter({ resolveBinary: () => "explicit-bin", listModels: async () => [] })).problems).toEqual([]);
  });
  it("refuses an id or alias that could not name a harness, and an alias that is the adapter's own id", () => {
    expect(checkAdapter(testAdapter({ aliases: ["former-name"] })).problems).toEqual([]);
    expect(checkAdapter(testAdapter({ id: "Claude Code" })).problems).toEqual([expect.stringMatching(/not lowercase/)]);
    expect(checkAdapter(testAdapter({ aliases: ["../escape"] })).problems).toEqual([expect.stringMatching(/each alias/)]);
    expect(checkAdapter(testAdapter({ aliases: ["test-harness"] })).problems).toEqual([expect.stringMatching(/each alias/)]);
    expect(checkAdapter(malformed({ aliases: "former-name" })).problems).toEqual([expect.stringMatching(/list of former ids/)]);
  });

  it("passes the conforming fixture, and actually ran checks to say so", () => {
    const { problems, checked } = checkAdapter(testAdapter());
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(10);
  });

  it("refuses a mode that is declared but has no implementation", () => {
    const { start: _start, ...declarationOnly } = hosted();
    const adapter = malformed({ modes: { ...testAdapter().modes, hosted: declarationOnly } });
    expect(checkAdapter(adapter, withCredentials).problems).toContain('mode "hosted" is declared but has no start()');
  });

  it("refuses an implementation that nobody vouched for", () => {
    const implementationOnly = { plan: guest.plan };
    const adapter = malformed({ modes: { ...testAdapter().modes, instrumented: implementationOnly } });
    const { problems } = checkAdapter(adapter);
    expect(problems).toContain('mode "instrumented" records no harness build in verifiedOn');
    expect(problems).toContain('mode "instrumented" must name the check that proved it and what that check proves');
    expect(problems).toContain('mode "instrumented" declares no guarantees');
  });

  it("refuses a slot left unanswered, which is not the same as null", () => {
    const adapter = malformed({ modes: { guest } });
    expect(checkAdapter(adapter).problems.join("\n")).toMatch(/must answer every slot/);
  });

  it("refuses a TUI mode that claims what only hosted can give", () => {
    const overclaiming: LaunchMode = { ...guest, guarantees: { ...guest.guarantees, gating: "per-call" } };
    const adapter = testAdapter({ modes: { hosted: null, instrumented: null, guest: overclaiming } });
    expect(checkAdapter(adapter).problems).toContain('mode "guest" claims per-call gating, which only hosted can give');
  });

  it("accepts the same claims on a hosted mode, with credentials declared", () => {
    const adapter = testAdapter({ modes: { hosted: hosted(), instrumented: null, guest } });
    expect(checkAdapter(adapter, withCredentials).problems).toEqual([]);
  });

  it("lets a TUI that renders the hosted session claim what hosted gives", () => {
    const attached: LaunchMode = { ...guest, attachesTo: "hosted", guarantees: { ...hosted().guarantees, keepsVendorUi: true } };
    const adapter = testAdapter({ modes: { hosted: hosted(), instrumented: attached, guest } });
    expect(checkAdapter(adapter, withCredentials).problems).toEqual([]);
  });

  it("refuses an attached TUI that claims more than its hosted mode, or has none to attach to", () => {
    const base = hosted({ guarantees: { ...guest.guarantees, capture: "near-total", interrupt: false, gating: "hooks" } });
    const overclaiming: LaunchMode = { ...guest, attachesTo: "hosted", guarantees: { ...base.guarantees, capture: "total", interrupt: true } };
    const problems = checkAdapter(testAdapter({ modes: { hosted: base, instrumented: overclaiming, guest } }), withCredentials).problems;
    expect(problems).toContain('mode "instrumented" claims more capture than its hosted mode gives');
    expect(problems).toContain('mode "instrumented" claims interrupt, which its hosted mode does not give');
    const orphan = checkAdapter(testAdapter({ modes: { hosted: null, instrumented: { ...guest, attachesTo: "hosted" }, guest } })).problems;
    expect(orphan).toContain('mode "instrumented" attaches to hosted, but the adapter declares no hosted mode');
  });

  it("refuses a hosted adapter that declares no credentials", () => {
    const adapter = testAdapter({ modes: { hosted: hosted(), instrumented: null, guest: null } });
    expect(checkAdapter(adapter).problems.join("\n")).toMatch(/hosted adapter declares no credentials/);
  });

  it("refuses a hosted adapter whose manifest credentials block is empty", () => {
    const adapter = testAdapter({ modes: { hosted: hosted(), instrumented: null, guest: null } });
    expect(checkAdapter(adapter, { bagManifest: { credentials: {} } }).problems.join("\n")).toMatch(
      /hosted adapter declares no credentials/,
    );
  });

  it("refuses a login requirement — the vendor-login modes are gone", () => {
    const adapter = malformed({
      requirements: {
        ...testAdapter().requirements,
        login: { check: ["codex", "login", "status"], fix: "codex login" },
      },
    });
    expect(checkAdapter(adapter).problems.join("\n")).toMatch(/declares a login requirement/);
  });

  it("refuses a default mode the adapter does not declare", () => {
    const adapter = testAdapter({ defaultMode: "hosted" });
    expect(checkAdapter(adapter).problems).toContain('default mode "hosted" is not declared');
  });

  it("refuses a version pattern that cannot find the pinned build", () => {
    const base = testAdapter();
    const adapter = testAdapter({
      requirements: { ...base.requirements, binary: { ...base.requirements.binary, versionPattern: "v(\\d+)" } },
    });
    expect(checkAdapter(adapter).problems.join("\n")).toMatch(/versionPattern .* found nothing, not the recommendation/);
  });

  it("reports a malformed adapter instead of throwing", () => {
    const { problems } = checkAdapter(
      malformed({ label: undefined, requirements: undefined, modes: undefined, defaultMode: undefined }),
    );
    expect(problems).toContain("adapter declares no binary requirement");
    expect(problems.length).toBeGreaterThan(2);
  });
});

it.each(["relative/bin", "", 17])("refuses an invalid declared binary path %s", path => {
  const adapter = testAdapter();
  Object.assign(adapter.requirements.binary, { paths: [path] });
  expect(checkAdapter(adapter).problems).toContain("requirements binary paths must be absolute paths");
});

it.each(["", "   ", 17])("refuses an invalid experimental reason %s", experimental => {
  expect(checkAdapter(malformed({ experimental })).problems).toContain("experimental must name missing evidence in a non-empty string");
});

it("checks native controls against the inventory and each other", () => {
  const check = (native: NonNullable<LaunchMode["native"]>) => checkAdapter(testAdapter({ tools: ["Read", "Write"], modes: { hosted: null, instrumented: null, guest: { ...guest, native } } })).problems.join("\n");
  expect(check({ grantable: ["Read"] })).toBe("");
  expect(check({ grantable: ["typo"] })).toMatch(/outside its inventory/);
  expect(check({ grantable: ["Read"], uncontrolled: { Read: "no switch" } })).toMatch(/both grantable and uncontrolled/);
  expect(check({ grantable: ["Read"], uncontrolled: { typo: "no switch" } })).toMatch(/uncontrolled tools outside/);
  expect(check({ grantable: ["Read"], inseparable: [["Read", "Write"]] })).toMatch(/inseparable set outside grantable/);
});
