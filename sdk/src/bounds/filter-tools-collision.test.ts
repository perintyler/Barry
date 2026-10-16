import { describe, it, expect } from "vitest";
import { filterTools, filterToolsQualified, qualifyToolId } from "./filter-tools.js";
import type { Bound, ToolDescriptor } from "./types.js";

/**
 * Two namespaces may export the same tool name. Authorization is decided per
 * (namespace, name) — the loop in filter-tools gets that right — but a result
 * keyed by bare name cannot express the decision, and a consumer testing
 * membership by name admits every tool sharing an allowed name.
 *
 * `filterTools` still returns bare names on purpose, for callers that want
 * something to display. These tests pin the difference so nobody "simplifies"
 * the qualified variant away on the grounds that the two look redundant.
 */

const SYSTEM_ONLY: Bound = {
  tools: { allow: ["system:read"] },
};

/** Same `toolName`, different namespaces — one allowed, one not. */
const COLLIDING: ToolDescriptor[] = [
  { toolName: "status", namespace: "system", access: "read" },
  { toolName: "status", namespace: "git", access: "read" },
];

describe("tool-name collisions across namespaces", () => {
  it("qualified filtering admits only the allowed namespace's tool", () => {
    const allowed = filterToolsQualified(COLLIDING, SYSTEM_ONLY);

    expect(allowed).toEqual(["system:status"]);
    expect(allowed).not.toContain("git:status");
  });

  it("a bare-name membership test cannot tell the two apart", () => {
    const bare = new Set(filterTools(COLLIDING, SYSTEM_ONLY));
    const deniedTool = COLLIDING.find((t) => t.namespace === "git")!;

    expect(bare.has(deniedTool.toolName)).toBe(true);

    const qualified = new Set(filterToolsQualified(COLLIDING, SYSTEM_ONLY));
    expect(qualified.has(qualifyToolId(deniedTool.namespace, deniedTool.toolName))).toBe(false);
  });

  it("keeps both when both namespaces are allowed", () => {
    const both: Bound = {
      tools: { allow: ["system:read", "git:read"] },
    };
    const allowed = filterToolsQualified(COLLIDING, both);

    expect(allowed.sort()).toEqual(["git:status", "system:status"]);
  });

  it("agrees with the bare filter on which tools survive", () => {
    const both: Bound = {
      tools: { allow: ["system:read", "git:read"] },
    };
    const bare = filterTools(COLLIDING, both);
    const qualified = filterToolsQualified(COLLIDING, both);

    expect(qualified).toHaveLength(bare.length);
    for (const id of qualified) {
      expect(bare).toContain(id.split(":").slice(1).join(":"));
    }
  });

  it("a wildcard namespace allow matches both namespaces", () => {
    const byName: Bound = {
      tools: { allow: ["*:status"] },
    };
    const allowed = filterToolsQualified(COLLIDING, byName);

    expect(allowed.sort()).toEqual(["git:status", "system:status"]);
  });
});

describe("per-tool bounds keyed by qualified id (SDK-4)", () => {
  it("a qualified tools allow admits only the named namespace's tool", () => {
    const qualified: Bound = {
      tools: { allow: ["system:status"] },
    };
    const allowed = filterToolsQualified(COLLIDING, qualified);

    expect(allowed).toEqual(["system:status"]);
    expect(allowed).not.toContain("git:status");
  });

  it("a bare tools allow matches both namespaces", () => {
    const bare: Bound = {
      tools: { allow: ["status"] },
    };
    const allowed = filterToolsQualified(COLLIDING, bare);
    expect(allowed.sort()).toEqual(["git:status", "system:status"]);
  });

  it("a qualified write allow does not elevate the same name in another namespace", () => {
    const writable: ToolDescriptor[] = [
      { toolName: "sync", namespace: "git", access: "write" },
      { toolName: "sync", namespace: "notes", access: "write" },
    ];
    const allowGitSync: Bound = {
      tools: { allow: ["git:sync"] },
    };
    const allowed = filterToolsQualified(writable, allowGitSync);
    expect(allowed).toEqual(["git:sync"]);
  });
});
