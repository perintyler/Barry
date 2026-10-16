import { describe, it, expect } from "vitest";
import { makeBagReachFilter } from "./bag-status.js";

const empty = { bags: [], namespaces: [], requested: [] };

describe("makeBagReachFilter", () => {
  it("keeps a bag named by the session's tools", () => {
    const reaches = makeBagReachFilter({ ...empty, bags: ["datadog-mcp"] });
    expect(reaches("datadog-mcp")).toBe(true);
  });

  it("drops a bag the session cannot reach at all", () => {
    const reaches = makeBagReachFilter({ ...empty, bags: ["datadog-mcp"] });
    expect(reaches("sentry-mcp")).toBe(false);
  });

  // A bag's namespace is not its registry key: `datadog-mcp` serves `datadog`.
  // Matching keys against namespaces silently matched nothing for every
  // `<service>-mcp` bag and reported a narrowed all-clear.
  it("does not confuse a namespace with a registry key", () => {
    const reaches = makeBagReachFilter({ ...empty, namespaces: ["datadog"] });
    expect(reaches("datadog")).toBe(true);
    expect(reaches("datadog-mcp")).toBe(false);
  });

  // The regression this exists for. An unauthorized bag serves NO tools, so it
  // appears in neither `bags` nor `namespaces` — a purely tool-derived filter
  // drops exactly the bag worth reporting. A session whose only packed bag is an
  // unauthorized bag must still be told about it.
  it("keeps an unauthorized bag that the session's bags requested", () => {
    const reaches = makeBagReachFilter({
      bags: [],          // serves no tools: it is unauthorized
      namespaces: [],
      requested: ["notion"],
    });
    expect(reaches("notion")).toBe(true);
  });

  it("still drops a bag no packed bag asked for", () => {
    const reaches = makeBagReachFilter({ ...empty, requested: ["notion"] });
    expect(reaches("sentry-mcp")).toBe(false);
  });

  it("reaches nothing when the session packs nothing", () => {
    const reaches = makeBagReachFilter(empty);
    expect(reaches("notion")).toBe(false);
  });
});
