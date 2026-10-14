import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getHostingConfig,
  getServicePort,
  getServiceUrl,
  originAllowed,
} from "./config.js";
import { writeServiceRegistry } from "./service-registry.js";

afterEach(() => vi.unstubAllEnvs());

function instanceWith(ports: Record<string, number>): void {
  vi.stubEnv("BARRY_HOME", mkdtempSync(join(tmpdir(), "barry-config-test-")));
  writeServiceRegistry({
    version: 2,
    generated: new Date().toISOString(),
    resources: Object.fromEntries(
      Object.entries(ports).map(([key, port]) => {
        const [bag, name] = key.split(".");
        return [key, { bag, name, kind: "service", url: `http://127.0.0.1:${port}` }];
      }),
    ),
  });
}

describe("service configuration", () => {
  it("finds core services in this instance's registry", () => {
    instanceWith({ "sessions.api": 4999, "mcp.server": 4998, "slack-app.events": 4997 });
    expect(getServiceUrl("api")).toBe("http://127.0.0.1:4999");
    expect(getServicePort("mcpBarry")).toBe(4998);
    expect(getServicePort("slack")).toBe(4997);
  });

  it("refuses a service the registry does not list, instead of a port that belongs to another instance", () => {
    instanceWith({});
    expect(() => getServiceUrl("api")).toThrow(/`sessions.api` is not in this instance's service registry/);
  });

  it("refuses the retired Redis alias rather than inventing a service address", () => {
    instanceWith({});
    expect(() => getServicePort("redis" as never)).toThrow("Unknown core service alias");
    vi.stubEnv("REDIS_URL", "redis://127.0.0.1:12000");
    expect(() => getServicePort("redis" as never)).toThrow("Unknown core service alias");
  });

  it("allows exactly the CORS origins the installation names", () => {
    vi.stubEnv("BARRY_CORS_ORIGINS", "https://home.test, https://lists.home.test");
    expect(getHostingConfig().allowedOrigins).toEqual(["https://home.test", "https://lists.home.test"]);
    vi.stubEnv("BARRY_CORS_ORIGINS", "");
    expect(getHostingConfig().allowedOrigins).toEqual([]);
  });
});

describe("originAllowed (step 17, SDK-21)", () => {
  it("matches a literal origin exactly and rejects a different host", () => {
    expect(originAllowed("https://app.barry.rocks", "https://app.barry.rocks")).toBe(true);
    expect(originAllowed("https://evil.example", "https://app.barry.rocks")).toBe(false);
  });
  it("treats * as a port-only wildcard with literal dots", () => {
    expect(originAllowed("http://localhost:5173", "http://localhost:*")).toBe(true);
    expect(originAllowed("http://localhost:65535", "http://localhost:*")).toBe(true);
    // A port wildcard must not widen across the dotted host: unescaped dots
    // were the drift that made a copied matcher quietly less protected.
    expect(originAllowed("http://localhostXevil", "http://localhost:*")).toBe(false);
    expect(originAllowed("http://localhost:abc", "http://localhost:*")).toBe(false);
    expect(originAllowed("http://other:5173", "http://localhost:*")).toBe(false);
  });
});
