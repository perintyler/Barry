import { describe, expect, it } from "vitest";
import { defineVendor, type Vendor } from "./vendors/index.js";
import { keylessRouteRefusal, routedEndpoint, routeModel, RouteRefused, type RoutingHarness } from "./route.js";

const VENDORS: Vendor[] = [
  defineVendor({ id: "anthropic", label: "Anthropic", credential: { env: "ANTHROPIC_API_KEY" }, models: [{ id: "claude-opus-5", label: "Opus", kind: "completion" }] }),
  defineVendor({
    id: "zai",
    label: "z.ai",
    compatible: [{ with: "anthropic", baseUrl: "https://z.example" }],
    credential: { env: "Z_AI_API_KEY" },
    models: [{ id: "glm-5.2", label: "GLM", kind: "completion", roles: ["default"] }],
  }),
  defineVendor({
    id: "ollama",
    label: "Ollama",
    compatible: [{ with: "anthropic", baseUrl: "http://ollama" }],
    credential: { placeholder: "ollama-local" },
    models: [
      { id: "qwen3:4b", label: "Qwen", kind: "completion", roles: ["default"] },
      { id: "nomic-embed-text", label: "Nomic", kind: "embedding", roles: ["default"] },
    ],
  }),
];

const CLAUDE: RoutingHarness = { id: "claude", vendor: "anthropic", capabilities: { endpoint: "configurable", withoutKey: "subscription-oauth" } };

describe("routeModel", () => {
  it("never routes a session to an embedding model", () => {
    expect(routeModel(CLAUDE, { model: "nomic-embed-text" }, VENDORS)).toEqual({
      model: "nomic-embed-text",
      vendor: undefined,
    });
  });

  it("applies an identity's default model for the running harness", () => {
    const renamed: RoutingHarness = { ...CLAUDE, id: "claude-code", aliases: ["claude"] };
    const identity = { model: "glm-5.2" };
    expect(routeModel(renamed, { identity }, VENDORS)).toEqual({ model: "glm-5.2", vendor: "zai" });
    expect(routeModel({ ...renamed, aliases: [] }, { identity }, VENDORS)).toEqual({ model: "glm-5.2", vendor: "zai" });
  });

  it("reads an identity's default model given as a ref, as it reads the session's own", () => {
    const identity = { model: "ollama/qwen3:4b" };
    expect(routeModel(CLAUDE, { identity }, VENDORS)).toEqual({ model: "qwen3:4b", vendor: "ollama" });
    // The harness's own vendor's model needs no routing.
    expect(routeModel(CLAUDE, { identity: { model: "anthropic/claude-opus-5" } }, VENDORS)).toEqual({ model: "claude-opus-5", vendor: undefined });
  });

  it("keeps the slashes of a model id whose prefix is no vendor", () => {
    expect(routeModel(CLAUDE, { model: "hf.co/org/name", vendor: "ollama" }, VENDORS)).toEqual({
      model: "hf.co/org/name",
      vendor: "ollama",
    });
  });

  it("refuses a ref that names a different vendor than the one asked for", () => {
    expect(() => routeModel(CLAUDE, { model: "zai/glm-5.2", vendor: "ollama" }, VENDORS)).toThrow(RouteRefused);
  });
});

describe("keylessRouteRefusal", () => {
  it("refuses a keyless endpoint on a harness that would fall back to the user's own login", () => {
    const refusal = keylessRouteRefusal(CLAUDE, { model: "glm-5.2", vendor: "zai" }, VENDORS, {});
    expect(refusal).toContain("Z_AI_API_KEY");
    expect(refusal).toContain("z.ai");
  });

  it("allows it once the key is there", () => {
    expect(keylessRouteRefusal(CLAUDE, { model: "glm-5.2", vendor: "zai" }, VENDORS, { Z_AI_API_KEY: "k" })).toBeNull();
  });

  it("allows an endpoint whose key is a placeholder, which Barry always supplies", () => {
    expect(keylessRouteRefusal(CLAUDE, { model: "qwen3:4b", vendor: "ollama" }, VENDORS, {})).toBeNull();
  });

  it("allows it on a harness with no login to leak", () => {
    const harness: RoutingHarness = { ...CLAUDE, capabilities: { endpoint: "configurable", withoutKey: "unauthenticated" } };
    expect(keylessRouteRefusal(harness, { model: "glm-5.2", vendor: "zai" }, VENDORS, {})).toBeNull();
  });

  it("has nothing to say about the harness's own vendor", () => {
    expect(keylessRouteRefusal(CLAUDE, { model: "claude-opus-5", vendor: undefined }, VENDORS, {})).toBeNull();
  });
});

describe("routedEndpoint", () => {
  /** A local daemon whose address is resolved at runtime, like Ollama's. */
  const DAEMON = defineVendor({
    id: "daemon",
    label: "Daemon",
    compatible: [{ with: "anthropic", baseUrl: { env: "DAEMON_URL", fallback: "http://127.0.0.1:1" } }],
    credential: { placeholder: "daemon-local" },
    models: [{ id: "small:1b", label: "Small", kind: "completion" }],
  });
  const ALL = [...VENDORS, DAEMON];

  it("points a harness at another vendor's door for its API, with that vendor's key from the session's env", () => {
    expect(routedEndpoint(CLAUDE, "zai/glm-5.2", ALL, { Z_AI_API_KEY: "zk" })).toEqual({ baseUrl: "https://z.example", apiKey: "zk" });
  });

  it("carries a local daemon's placeholder key, so the harness never falls back to the user's login", () => {
    expect(routedEndpoint(CLAUDE, "ollama/qwen3:4b", ALL, {})).toEqual({ baseUrl: "http://ollama", apiKey: "ollama-local" });
  });

  it("resolves a runtime address from the session's env", () => {
    expect(routedEndpoint(CLAUDE, "daemon/small:1b", ALL, { DAEMON_URL: "http://10.0.0.5:1" })?.baseUrl).toBe("http://10.0.0.5:1");
    expect(routedEndpoint(CLAUDE, "daemon/small:1b", ALL, {})?.baseUrl).toBe("http://127.0.0.1:1");
  });

  it("moves a runtime-resolved address when told to, and never a vendor's fixed one", () => {
    expect(routedEndpoint(CLAUDE, "daemon/small:1b", ALL, {}, { baseUrl: "http://elsewhere:1" })?.baseUrl).toBe("http://elsewhere:1");
    expect(routedEndpoint(CLAUDE, "zai/glm-5.2", ALL, { Z_AI_API_KEY: "zk" }, { baseUrl: "http://elsewhere:1" })?.baseUrl).toBe("https://z.example");
  });

  it("leaves the harness's own vendor, a model named without its vendor, and a harness it cannot point, alone", () => {
    expect(routedEndpoint(CLAUDE, "anthropic/claude-opus-5", ALL, {})).toBeUndefined();
    expect(routedEndpoint(CLAUDE, "glm-5.2", ALL, {})).toBeUndefined();
    const fixed: RoutingHarness = { ...CLAUDE, capabilities: { endpoint: "fixed", withoutKey: "subscription-oauth" } };
    expect(routedEndpoint(fixed, "zai/glm-5.2", ALL, { Z_AI_API_KEY: "zk" })).toBeUndefined();
  });
});
