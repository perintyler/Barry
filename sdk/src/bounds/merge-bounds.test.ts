import { parseManifest } from "../bags/manifest.js";
import { resolveNativePolicy, nativeToolsTakenBack } from "./native-policy.js";
const manifest = parseManifest(new URL("../../../adapters/sessions/claude", import.meta.url).pathname)!;
const harness = { id: "claude-code", nativeTools: [...new Set(Object.values(manifest.bounds!).flatMap((b) => b.bound.nativeTools?.["claude-code"] ?? []))], bag: { path: "", manifest } };
const boundNeedsNativeToolDenial = (bound?: import("./types.js").Bound) => nativeToolsTakenBack(bound, harness).includes("Bash");
const boundNeedsNativeFileToolDenial = (bound?: import("./types.js").Bound) => nativeToolsTakenBack(bound, harness).includes("Read");
import { describe, it, expect } from "vitest";
import { mergeBounds, mergeNetwork, boundHasContent } from "./merge-bounds.js";

describe("mergeNetwork", () => {
  it("unions actions and domains", () => {
    const merged = mergeNetwork(
      { actions: ["write"], domains: ["a.com"] },
      { actions: ["dns"], domains: ["b.com"] },
    );
    expect(merged?.actions?.sort()).toEqual(["dns", "write"]);
    expect(merged?.domains?.sort()).toEqual(["a.com", "b.com"]);
  });

  it("escalates enforce to sandbox from either side", () => {
    expect(mergeNetwork({ enforce: "guard" }, { enforce: "sandbox" })?.enforce).toBe("sandbox");
    expect(mergeNetwork({ enforce: "sandbox" }, { enforce: "guard" })?.enforce).toBe("sandbox");
  });

  it("keeps guard when neither side escalates", () => {
    expect(mergeNetwork({ enforce: "guard" }, {})?.enforce).toBe("guard");
  });

  it("returns undefined when both sides are empty", () => {
    expect(mergeNetwork(undefined, undefined)).toBeUndefined();
  });

  describe("allowDomains — intersects, unlike every other field", () => {
    it("keeps only hosts BOTH sources permit", () => {
      const merged = mergeNetwork(
        { allowDomains: ["a.com", "b.com"] },
        { allowDomains: ["b.com", "c.com"] },
      );
      expect(merged?.allowDomains).toEqual(["b.com"]);
    });

    it("treats an absent list as no-opinion, not as deny-all", () => {
      // undefined is the identity element: a scope that says nothing about
      // allowed hosts must not silently revoke another scope's allowances.
      expect(mergeNetwork({ allowDomains: ["a.com"] }, {})?.allowDomains).toEqual(["a.com"]);
      expect(mergeNetwork({}, { allowDomains: ["a.com"] })?.allowDomains).toEqual(["a.com"]);
    });

    it("an explicit empty list does mean deny-all and wins", () => {
      expect(mergeNetwork({ allowDomains: ["a.com"] }, { allowDomains: [] })?.allowDomains)
        .toEqual([]);
    });

    it("disjoint allowlists collapse to nothing permitted", () => {
      expect(mergeNetwork({ allowDomains: ["a.com"] }, { allowDomains: ["b.com"] })?.allowDomains)
        .toEqual([]);
    });

    it("never widens: merging cannot introduce a host neither side allowed", () => {
      const merged = mergeNetwork({ allowDomains: ["a.com"] }, { allowDomains: ["b.com"] });
      expect(merged?.allowDomains).not.toContain("c.com");
    });
  });
});

describe("mergeBounds", () => {
  it("is a union of denials, not an override", () => {
    // The API server previously used `inline ?? named`, which DISCARDED the
    // named bound whenever an inline network bag existed — silently dropping
    // enforce: "sandbox". Merging must preserve both sides.
    const named = { network: { actions: ["all"], enforce: "sandbox" as const } };
    const inline = { network: { domains: ["evil.com"] } };
    const merged = mergeBounds(named, inline);
    expect(merged?.network?.enforce).toBe("sandbox");
    expect(merged?.network?.actions).toEqual(["all"]);
    expect(merged?.network?.domains).toEqual(["evil.com"]);
  });

  it("unions every dimension", () => {
    const merged = mergeBounds(
      { deniedTools: ["Bash"], files: { deny: ["*.env"] } },
      { deniedTools: ["Write"], bash: { denyPrograms: ["git"] } },
    );
    expect(merged?.deniedTools?.sort()).toEqual(["Bash", "Write"]);
    expect(merged?.files?.deny).toEqual(["*.env"]);
    expect(merged?.bash?.denyPrograms).toEqual(["git"]);
  });

  it("passes through when one side is null", () => {
    const bound = { deniedTools: ["Bash"] };
    expect(mergeBounds(null, bound)).toEqual(bound);
    expect(mergeBounds(bound, null)).toEqual(bound);
    expect(mergeBounds(null, null)).toBeNull();
  });

  describe("files.allowOnly — intersects, like allowDomains", () => {
    it("keeps only paths BOTH sources permit", () => {
      const merged = mergeBounds(
        { files: { allowOnly: ["/repos/vantage/**", "/repos/bags/**"] } },
        { files: { allowOnly: ["/repos/vantage/**"] } },
      );
      expect(merged?.files?.allowOnly).toEqual(["/repos/vantage/**"]);
    });

    it("treats an absent list as no-opinion, not as deny-all", () => {
      expect(mergeBounds({ files: { allowOnly: ["/a/**"] } }, {})?.files?.allowOnly).toEqual(["/a/**"]);
      expect(mergeBounds({}, { files: { allowOnly: ["/a/**"] } })?.files?.allowOnly).toEqual(["/a/**"]);
    });

    it("an explicit empty list does mean allow-nothing and wins", () => {
      expect(mergeBounds({ files: { allowOnly: ["/a/**"] } }, { files: { allowOnly: [] } })?.files?.allowOnly)
        .toEqual([]);
    });

    it("disjoint allowlists collapse to nothing permitted", () => {
      expect(mergeBounds({ files: { allowOnly: ["/a/**"] } }, { files: { allowOnly: ["/b/**"] } })?.files?.allowOnly)
        .toEqual([]);
    });

    it("deny unions alongside a surviving allowlist", () => {
      const merged = mergeBounds(
        { files: { deny: ["*.env"], allowOnly: ["/a/**"] } },
        { files: { deny: [".ssh/**"] } },
      );
      expect(merged?.files?.deny?.sort()).toEqual(["*.env", ".ssh/**"]);
      expect(merged?.files?.allowOnly).toEqual(["/a/**"]);
    });
  });

  describe("undefined-when-empty (SDK-17)", () => {
    // Every merger must agree on the empty case: two bounds that both carry
    // empty sub-objects must produce the SAME shape as a bound that omits them,
    // or `scopeFingerprint` hashes `{bash:{}}` and absent-bash differently and
    // two equivalent scopes look distinct.
    it("mergeBash yields undefined, not {}, when both sides are empty arrays", () => {
      const merged = mergeBounds(
        { bash: { deny: [], denyPrograms: [] } },
        { bash: { deny: [], denyPrograms: [] } },
      );
      expect(merged?.bash).toBeUndefined();
    });

    it("the three sub-object mergers agree on the empty case", () => {
      const merged = mergeBounds(
        { bash: { deny: [] }, files: { deny: [] }, network: {} },
        { bash: { deny: [] }, files: { deny: [] }, network: {} },
      );
      expect(merged?.bash).toBeUndefined();
      expect(merged?.files).toBeUndefined();
      expect(merged?.network).toBeUndefined();
    });

    it("omits nodes entirely when neither side carries a node rule", () => {
      // Previously emitted `{ allow: undefined, deny: undefined }` whenever
      // either side merely mentioned nodes, so a touched-but-empty nodes field
      // serialized differently from an absent one.
      const merged = mergeBounds({ nodes: {} }, { deniedTools: ["Bash"] });
      expect(merged?.nodes).toBeUndefined();
      expect("nodes" in merged! ? merged!.nodes : undefined).toBeUndefined();
    });

    it("still merges real node rules: deny unions, allow intersects", () => {
      const merged = mergeBounds(
        { nodes: { allow: ["a", "b"], deny: ["x"] } },
        { nodes: { allow: ["b", "c"], deny: ["y"] } },
      );
      expect(merged?.nodes?.allow).toEqual(["b"]);
      expect(merged?.nodes?.deny?.sort()).toEqual(["x", "y"]);
    });
  });
});

describe("boundHasContent", () => {
  it("counts an enforce-only network bound as content", () => {
    // Omitting this dropped `{network:{enforce:"sandbox"}}` trait bounds
    // before they ever reached the merge, silently losing the escalation.
    expect(boundHasContent({ network: { enforce: "sandbox" } })).toBe(true);
  });

  it("counts each dimension", () => {
    expect(boundHasContent({ deniedTools: ["Bash"] })).toBe(true);
    expect(boundHasContent({ deniedAccess: ["write"] })).toBe(true);
    expect(boundHasContent({ files: { deny: ["*.env"] } })).toBe(true);
    expect(boundHasContent({ bash: { denyPrograms: ["git"] } })).toBe(true);
    expect(boundHasContent({ network: { actions: ["all"] } })).toBe(true);
    expect(boundHasContent({ network: { domains: ["a.com"] } })).toBe(true);
  });

  it("counts an empty allowDomains as content (it means deny-all)", () => {
    expect(boundHasContent({ network: { allowDomains: [] } })).toBe(true);
    expect(boundHasContent({ network: { allowDomains: ["a.com"] } })).toBe(true);
  });

  it("counts files.allowOnly as content, empty or not (it means allow-nothing)", () => {
    expect(boundHasContent({ files: { allowOnly: [] } })).toBe(true);
    expect(boundHasContent({ files: { allowOnly: ["/a/**"] } })).toBe(true);
  });

  it("rejects empty bounds", () => {
    expect(boundHasContent(undefined)).toBe(false);
    expect(boundHasContent({})).toBe(false);
    expect(boundHasContent({ network: {} })).toBe(false);
  });
});

describe("explicit native policies", () => {
  it("blocks native tools even without MCP restrictions", () => {
    expect(boundNeedsNativeToolDenial({ bash: { denyPrograms: ["git"] } })).toBe(true);
    expect(boundNeedsNativeToolDenial({ network: { actions: ["all"] } })).toBe(true);
    expect(boundNeedsNativeFileToolDenial({ files: { allowOnly: ["/a/**"] } })).toBe(true);
    expect(resolveNativePolicy({ bound: null, tools: [] }, harness, "guest").denied).toEqual([...new Set(harness.nativeTools)]);
    expect(resolveNativePolicy({ bound: null, tools: [] }, harness, "hosted").denied).toEqual([...new Set(harness.nativeTools)]);
  });
  it("honors explicitly selected native bounds in both launch lanes", () => {
    const bound = { nativeTools: { "claude-code": ["Bash", "Read"] } };
    expect(boundNeedsNativeToolDenial(bound)).toBe(true);
    expect(boundNeedsNativeFileToolDenial(bound)).toBe(true);
    expect(resolveNativePolicy({ bound, tools: [] }, harness, "hosted").denied).toContain("Bash");
  });
});

it("removes names and descriptions from every effective merge", () => {
  const named = { name: "quiet", description: "No shell", deniedTools: ["Bash"] };
  expect(mergeBounds(null, named)).toEqual({ deniedTools: ["Bash"] });
  expect(mergeBounds(named, null)).toEqual({ deniedTools: ["Bash"] });
  expect(mergeBounds(named, named)).not.toHaveProperty("name");
  expect(mergeBounds(named, named)).not.toHaveProperty("description");
});
