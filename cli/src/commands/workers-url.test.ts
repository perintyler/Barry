import { expect, it } from "vitest";
import { parseHostingConfig } from "@barry-rocks/sdk/services";
import { resolveHosting, type HostedService, type HostingProvider } from "../services/hosting/resolve.js";
import type { AppliedFile } from "@barry-rocks/sdk/services";
import { chooseWorkflowsUrl, routesFor } from "./workers-url.js";

const services: HostedService[] = [{ key: "workflows.runtime", bag: "workflows", name: "runtime", url: "http://127.0.0.1:4900", localOnly: false }];
const providers: HostingProvider[] = [
  { bag: "private-tunnel", provides: { tunnel: { reach: ["private"], gates: [] } } },
  { bag: "public-tunnel", provides: { tunnel: { reach: ["public"], gates: ["access"] } } },
];
const applied = (provider: string): AppliedFile | null => provider === "private-tunnel"
  ? { version: 1, provider, generation: 1, reported: new Date().toISOString(), routes: [], instances: { personal: { address: "barry-mac.example.ts.net" } } }
  : null;
const plan = (yaml: string) => resolveHosting(parseHostingConfig(yaml), services, providers);

it("addresses a private route by the instance name its provider reported, and a public one by its domain", () => {
  const routes = routesFor(plan(`
tunnels:
  phone: { via: private-tunnel, instance: personal, reach: private, routes: { "8451": workflows.runtime } }
  web: { via: public-tunnel, instance: mac, reach: public, domain: example.com, gate: access, routes: { jobs: workflows.runtime } }
`), applied);
  expect(routes).toEqual([
    { url: "https://barry-mac.example.ts.net:8451", reach: "private", gate: "none" },
    { url: "https://jobs.example.com", reach: "public", gate: "access" },
  ]);
  expect(chooseWorkflowsUrl(routes)).toBe("https://barry-mac.example.ts.net:8451");
});

it("refuses an invite address it would have to guess, or one behind a login gate", () => {
  expect(() => chooseWorkflowsUrl([])).toThrow(/not published beyond this machine/);
  expect(() => chooseWorkflowsUrl([{ url: "https://jobs.example.com", reach: "public", gate: "access" }])).toThrow(/login gate/);
  expect(() => chooseWorkflowsUrl([{ url: "https://a:1", reach: "private", gate: "none" }, { url: "https://b:2", reach: "private", gate: "none" }])).toThrow(/--url/);
});
