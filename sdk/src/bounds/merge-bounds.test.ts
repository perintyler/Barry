import { parseManifest } from "../bags/manifest.js";
import { resolveNativeTools, nativeToolsTakenBack } from "./native-tools.js";
import { NATIVE_TOOLS } from "../../../adapters/sessions/claude/src/native-tools.js";
const manifest = parseManifest(new URL("../../../adapters/sessions/claude", import.meta.url).pathname)!;
const harness = { id: "claude-code", tools: NATIVE_TOOLS, bag: { path: "", manifest } };
const boundNeedsNativeToolDenial = (bound?: import("./types.js").Bound) => nativeToolsTakenBack(bound, harness).includes("Bash");
const boundNeedsNativeFileToolDenial = (bound?: import("./types.js").Bound) => nativeToolsTakenBack(bound, harness).includes("Read");
import { describe, it, expect } from "vitest";
import { mergeBounds, mergeNetwork, boundHasContent } from "./merge-bounds.js";

describe("mergeNetwork", () => {
  it("unions deny rules across actions and domains", () => {
    const merged = mergeNetwork(
      { deny: ["write", "a.com"] },
      { deny: ["dns", "b.com"] },
    );
    expect(merged?.deny?.sort()).toEqual(["a.com", "b.com", "dns", "write"]);
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

  describe("network.allow — intersects", () => {
    it("keeps only hosts BOTH sources permit", () => {
      const merged = mergeNetwork(
        { allow: ["a.com", "b.com"] },
        { allow: ["b.com", "c.com"] },
      );
      expect(merged?.allow).toEqual(["b.com"]);
    });

    it("treats an absent list as no-opinion, not as deny-all", () => {
      expect(mergeNetwork({ allow: ["a.com"] }, {})?.allow).toEqual(["a.com"]);
      expect(mergeNetwork({}, { allow: ["a.com"] })?.allow).toEqual(["a.com"]);
    });

    it("an explicit empty list means allow-nothing and wins", () => {
      expect(mergeNetwork({ allow: ["a.com"] }, { allow: [] })?.allow)
        .toEqual([]);
    });

    it("disjoint allowlists collapse to nothing permitted", () => {
      expect(mergeNetwork({ allow: ["a.com"] }, { allow: ["b.com"] })?.allow)
        .toEqual([]);
    });

    it("never widens: merging cannot introduce a host neither side allowed", () => {
      const merged = mergeNetwork({ allow: ["a.com"] }, { allow: ["b.com"] });
      expect(merged?.allow).not.toContain("c.com");
    });
  });
});

describe("mergeBounds", () => {
  it("is a union of denials, not an override", () => {
    const named = { network: { deny: ["all"], enforce: "sandbox" as const } };
    const inline = { network: { deny: ["evil.com"] } };
    const merged = mergeBounds(named, inline);
    expect(merged?.network?.enforce).toBe("sandbox");
    expect(merged?.network?.deny).toEqual(["all", "evil.com"]);
  });

  it("unions every dimension", () => {
    const merged = mergeBounds(
      { tools: { deny: ["*:Bash"] }, files: { deny: ["*.env"] } },
      { tools: { deny: ["*:Write"] }, bash: { deny: ["git *"] } },
    );
    expect(merged?.tools?.deny?.sort()).toEqual(["*:Bash", "*:Write"]);
    expect(merged?.files?.deny).toEqual(["*.env"]);
    expect(merged?.bash?.deny).toEqual(["git *"]);
  });

  it("passes through when one side is null", () => {
    const bound = { tools: { deny: ["*:Bash"] } };
    expect(mergeBounds(null, bound)).toEqual(bound);
    expect(mergeBounds(bound, null)).toEqual(bound);
    expect(mergeBounds(null, null)).toBeNull();
  });

  describe("files.allow — intersects", () => {
    it("keeps only paths BOTH sources permit", () => {
      const merged = mergeBounds(
        { files: { allow: ["/repos/vantage/**", "/repos/bags/**"] } },
        { files: { allow: ["/repos/vantage/**"] } },
      );
      expect(merged?.files?.allow).toEqual(["/repos/vantage/**"]);
    });

    it("treats an absent list as no-opinion, not as deny-all", () => {
      expect(mergeBounds({ files: { allow: ["/a/**"] } }, {})?.files?.allow).toEqual(["/a/**"]);
      expect(mergeBounds({}, { files: { allow: ["/a/**"] } })?.files?.allow).toEqual(["/a/**"]);
    });

    it("an explicit empty list means allow-nothing and wins", () => {
      expect(mergeBounds({ files: { allow: ["/a/**"] } }, { files: { allow: [] } })?.files?.allow)
        .toEqual([]);
    });

    it("disjoint allowlists collapse to nothing permitted", () => {
      expect(mergeBounds({ files: { allow: ["/a/**"] } }, { files: { allow: ["/b/**"] } })?.files?.allow)
        .toEqual([]);
    });

    it("deny unions alongside a surviving allowlist", () => {
      const merged = mergeBounds(
        { files: { deny: ["*.env"], allow: ["/a/**"] } },
        { files: { deny: [".ssh/**"] } },
      );
      expect(merged?.files?.deny?.sort()).toEqual(["*.env", ".ssh/**"]);
      expect(merged?.files?.allow).toEqual(["/a/**"]);
    });
  });

  describe("undefined-when-empty (SDK-17)", () => {
    it("mergeBash yields undefined, not {}, when both sides are empty arrays", () => {
      const merged = mergeBounds(
        { bash: { deny: [] } },
        { bash: { deny: [] } },
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
      const merged = mergeBounds({ nodes: {} }, { tools: { deny: ["*:Bash"] } });
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
    expect(boundHasContent({ network: { enforce: "sandbox" } })).toBe(true);
  });

  it("counts each dimension", () => {
    expect(boundHasContent({ tools: { deny: ["*:Bash"] } })).toBe(true);
    expect(boundHasContent({ tools: { deny: ["*:write"] } })).toBe(true);
    expect(boundHasContent({ files: { deny: ["*.env"] } })).toBe(true);
    expect(boundHasContent({ bash: { deny: ["git *"] } })).toBe(true);
    expect(boundHasContent({ network: { deny: ["all"] } })).toBe(true);
    expect(boundHasContent({ network: { deny: ["a.com"] } })).toBe(true);
  });

  it("counts an empty network.allow as content (it means allow-nothing)", () => {
    expect(boundHasContent({ network: { allow: [] } })).toBe(true);
    expect(boundHasContent({ network: { allow: ["a.com"] } })).toBe(true);
  });

  it("counts files.allow as content, empty or not (it means allow-nothing)", () => {
    expect(boundHasContent({ files: { allow: [] } })).toBe(true);
    expect(boundHasContent({ files: { allow: ["/a/**"] } })).toBe(true);
  });

  it("rejects empty bounds", () => {
    expect(boundHasContent(undefined)).toBe(false);
    expect(boundHasContent({})).toBe(false);
    expect(boundHasContent({ network: {} })).toBe(false);
  });
});

describe("explicit native tool bounds", () => {
  it("blocks native tools even without MCP restrictions", () => {
    expect(boundNeedsNativeToolDenial({ bash: { deny: ["git *"] } })).toBe(true);
    expect(boundNeedsNativeToolDenial({ network: { deny: ["all"] } })).toBe(true);
    expect(boundNeedsNativeFileToolDenial({ files: { allow: ["/a/**"] } })).toBe(true);
    expect(resolveNativeTools({ bound: null, tools: [] }, harness, "guest").denied).toEqual([...new Set(harness.tools)]);
    expect(resolveNativeTools({ bound: null, tools: [] }, harness, "hosted").denied).toEqual([...new Set(harness.tools)]);
  });
  it("honors explicitly selected native bounds in both launch lanes", () => {
    const bound = { tools: { deny: ["claude-code:Bash", "claude-code:Read"] } };
    expect(boundNeedsNativeToolDenial(bound)).toBe(true);
    expect(boundNeedsNativeFileToolDenial(bound)).toBe(true);
    expect(resolveNativeTools({ bound, tools: [] }, harness, "hosted").denied).toContain("Bash");
  });
});

it("removes names and descriptions from every merged bound", () => {
  const named = { name: "quiet", description: "No shell", tools: { deny: ["*:Bash"] } };
  expect(mergeBounds(null, named)).toEqual({ tools: { deny: ["*:Bash"] } });
  expect(mergeBounds(named, null)).toEqual({ tools: { deny: ["*:Bash"] } });
  expect(mergeBounds(named, named)).not.toHaveProperty("name");
  expect(mergeBounds(named, named)).not.toHaveProperty("description");
});
