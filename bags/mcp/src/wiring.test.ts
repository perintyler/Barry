import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transportsWithDeadOwners } from "./dead-sessions.js";

/**
 * Wiring assertions for the MCP entrypoint.
 *
 * index.ts builds its servers inside request handlers, so the wiring is awkward
 * to exercise directly. These read the source instead — crude, but they pin
 * down a placement mistake that produced a live bypass and that no unit test
 * caught, because `wrapShellEditGuard` itself was always correct.
 */
const source = readFileSync(fileURLToPath(new URL("./application.ts", import.meta.url)), "utf8");
// The live-refresh path moved to a sibling module; some wiring assertions below
// span both files so the shared wrapping chain stays pinned wherever it lives.
const refreshSource = readFileSync(fileURLToPath(new URL("./transport-refresh.ts", import.meta.url)), "utf8");

/** The body of each `if (barrySessionId) { … }` bag. */
function sessionOnlyBags(): string[] {
  const bags: string[] = [];
  const marker = "if (barrySessionId) {";
  let from = 0;
  for (;;) {
    const start = source.indexOf(marker, from);
    if (start === -1) break;
    let depth = 0;
    let i = start + marker.length - 1;
    for (; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    bags.push(source.slice(start, i + 1));
    from = i + 1;
  }
  return bags;
}

describe("shell edit guard wiring", () => {
  it("is applied on both the aggregate and namespace endpoints", () => {
    // Both endpoints (and the live-refresh path) route through the one shared
    // wrapping chain, whose last step is the shell guard. Consolidation is the
    // point: both POST routes now go through a single handleMcpRequest, so the
    // initialize path wraps exactly once (`sessionTools = wrapForServing`) and
    // the refresh path once (`nextTools = wrapForServing`) — "one endpoint
    // forgot a wrapper" is no longer a representable state.
    expect(source).toContain("sessionTools = wrapForServing(");
    expect(refreshSource).toContain("nextTools = wrapForServing(");
    // The one shared handler feeds a namespace-scoped tool set through the same
    // `sessionTools = wrapForServing(` call, so there is no separate
    // `nsTools = wrapForServing(` site to assert any more.
    expect(source).toContain("return wrapShellEditGuard(out);");
  });

  it("is NOT gated on barrySessionId", () => {
    // The guard takes no session argument: routing a file write through the
    // edit tools is right for every caller. Gating it meant any client
    // connecting without `?sessionId=` got a completely unguarded shell —
    // confirmed live, where a python one-liner wrote its file unimpeded.
    for (const bag of sessionOnlyBags()) {
      expect(bag).not.toContain("wrapShellEditGuard");
    }
  });

  it("still gates the wrappers that genuinely need a session", () => {
    // wrapEditIntent and wrapEditRecording attribute work to a session, so they
    // must stay inside the branch — this guards against "fixing" the above by
    // hoisting everything out.
    const bags = sessionOnlyBags().join("\n");
    expect(bags).toContain("wrapEditIntent");
    expect(bags).toContain("wrapEditRecording");
  });
});

describe("transportsWithDeadOwners", () => {
  const owners = { "mcp-a": "session-1", "mcp-b": "session-2", "mcp-c": "session-1" };

  it("selects every transport belonging to a dead session", () => {
    // One agent session opens one transport per namespace, so a single dead
    // session must take all of its transports with it — leaving one behind
    // keeps its pool keys alive and defeats the whole reap.
    const picked = transportsWithDeadOwners(owners, new Set(["session-1"]));
    expect(picked.map(([sid]) => sid).sort()).toEqual(["mcp-a", "mcp-c"]);
  });

  it("leaves live sessions untouched", () => {
    const picked = transportsWithDeadOwners(owners, new Set(["session-2"]));
    expect(picked).toEqual([["mcp-b", "session-2"]]);
  });

  it("reaps nothing when liveness is unknown", () => {
    // findDeadSessions fails OPEN: an unreachable API yields an empty set,
    // which must mean "reap on TTL only", never "every session is dead".
    expect(transportsWithDeadOwners(owners, new Set())).toEqual([]);
  });

  it("ignores anonymous transports", () => {
    // Transports with no ?sessionId= never enter transportOwner, so they can
    // never be selected here — they are bounded by MAX_ANONYMOUS_TRANSPORTS.
    expect(transportsWithDeadOwners({}, new Set(["session-1"]))).toEqual([]);
  });
});

/** Every admission path must release its reservation in a finally block.
 * Rationale: docs/decisions/0033-tracked-capture-and-transport-rationale.md.
 */
describe("admission reservation wiring", () => {
  it("the unified /mcp handler releases the reservation via a try/finally", () => {
    const releaseCount = (source.match(/pendingAdmissions\.release\(admissionId\)/g) ?? []).length;
    // One release inside registerTransport() (success path) + one in the single
    // shared handler's finally (every other exit) = 2. Both POST routes now go
    // through that one handler, so there is no per-route duplicate.
    expect(releaseCount).toBe(2);
  });

  it("registerTransport is only ever called (not just defined) with the reservation id threaded through", () => {
    // Match call sites across formatting changes; exclude the function
    // definition itself and the "Released by registerTransport()" comment
    // mentions, neither of which is a call this check cares about.
    const calls = source.match(/^\s*registerTransport\([\s\S]*?\);/gm) ?? [];
    // One call site: the single handleMcpRequest onsessioninitialized callback,
    // shared by both /mcp and /mcp/ns/:namespace.
    expect(calls.length).toBe(1);
    for (const call of calls) {
      expect(call).toMatch(/,\s*admissionId\s*,\s*req\s*,?\s*\);\s*$/);
    }
  });

  it("the unified handler does not treat admitTransport's result as a bare boolean", () => {
    // The old shape was `if (!admitTransport(id))`. The new shape captures
    // the reservation id and checks it against null — losing that distinction
    // silently drops the reservation this fix depends on.
    expect(source).not.toMatch(/if \(!admitTransport\(/);
    const checks = (source.match(/if \(admissionId === null\)/g) ?? []).length;
    // One check in the single shared handleMcpRequest.
    expect(checks).toBe(1);
  });
});
