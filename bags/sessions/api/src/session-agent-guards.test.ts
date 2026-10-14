import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Barry } from "@barry-rocks/sdk";
import { fakeIdentities } from "@barry-rocks/sdk/testing";
import { sessionPolicyOver } from "@barry-rocks/identities-bag/testing";
import type { TraitInfo } from "@barry-rocks/identities-bag";
import { loadAdapters } from "@barry-rocks/sdk/internal/adapters";
import type { InstalledAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import { parseManifest } from "@barry-rocks/sdk/bags";
import { parseBounds } from "@barry-rocks/sdk/internal/identities";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Bound } from "@barry-rocks/sdk/bounds";
vi.mock("./db.js", () => ({ getSessionRecord: vi.fn(async () => undefined) }));
vi.mock("./agent-runtime.js", () => ({ getDescribeAdapter: vi.fn() }));
import { getDescribeAdapter } from "./agent-runtime.js";
import { nativeToolPolicy, sessionAgentGrants } from "./session-agent-guards.js";

let records: InstalledAdapter[];
let bound: Bound | null = null;
beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), "barry-native-api-"));
  vi.stubEnv("BARRY_HOME", root);
  const adapters = loadAdapters({ file: join(root, "adapters.json"), registerBag: async () => {} });
  records = await Promise.all(["claude", "cursor", "pi"].map(folder => adapters.add(new URL(`../../../../adapters/sessions/${folder}`, import.meta.url).pathname)));
  const bash = parseManifest(new URL("../../../bash", import.meta.url).pathname)!;
  const manifests = [...records.map(record => record.bag!.manifest), bash];
  const traits: TraitInfo[] = manifests.flatMap(manifest => Object.entries(manifest.traits).map(([name, trait]) => ({ ...trait, name, bag: manifest.name, description: trait.description ?? null, namespaces: trait.bags, tools: [], bound: trait.bound ?? {} })));
  const bounds: Record<string, { bound: Bound }> = { ...Object.fromEntries(parseBounds(parse(readFileSync(new URL("../../../../identity.yaml", import.meta.url), "utf8")).bounds).map(entry => [entry.name, { bound: entry.bound! }])), ...Object.assign({}, ...manifests.map(manifest => manifest.bounds)) };
  const policy = sessionPolicyOver({ identity: async () => undefined, config: () => { throw Error("no identity"); }, traits: async () => traits, bounds: async () => Object.entries(bounds).map(([name, definition]) => ({ id: 1, token: "fixture", name, description: null, bound: definition.bound })), harness: id => records.find(record => record.id === id || record.aliases?.includes(id)), harnesses: () => records });
  Barry.use(fakeIdentities({ grants: async (_ref, selection) => policy.grants(undefined, { ...selection, inlineBound: bound }, []) }));
  vi.mocked(getDescribeAdapter).mockReturnValue(id => records.find(record => record.id === id || record.aliases?.includes(id)));
});
afterEach(() => { bound = null; });
afterAll(() => { Barry.reset(); vi.unstubAllEnvs(); });
it("uses hosted grants for allowed native file reads", async () => {
  expect((await sessionAgentGrants({ id: "s", provider: "claude" }, ["native-file-reads"])).traits).toEqual(["claude:native-file-reads"]);
  expect((await nativeToolPolicy({ id: "s", provider: "claude" }, ["native-file-reads"])).allowed).toEqual(["Read", "Glob", "Grep"]);
});
it("takes back network and shell grants at the API seam", async () => {
  bound = { network: { actions: ["all"] } };
  expect((await nativeToolPolicy({ id: "s", provider: "claude" }, ["native-network"])).allowed).toEqual([]);
  bound = null;
  expect((await nativeToolPolicy({ id: "s", provider: "claude" }, ["native-shell", "bash:no-bash"])).allowed).toEqual([]);
});
it("reports cursor controls and a bound conflict, and grants nothing for pi network", async () => {
  expect((await nativeToolPolicy({ id: "s", provider: "cursor" })).uncontrolled).toHaveProperty("Grep");
  bound = { files: { deny: ["**/.env"] } };
  expect((await nativeToolPolicy({ id: "s", provider: "cursor" })).conflicts).toHaveProperty("Grep");
  bound = null;
  expect((await nativeToolPolicy({ id: "s", provider: "pi" }, ["native-network"])).allowed).toEqual([]);
});
