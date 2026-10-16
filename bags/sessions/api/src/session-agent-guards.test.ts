import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { Barry } from "@barry-rocks/sdk";
import { fakeIdentities } from "@barry-rocks/sdk/testing";
import { loadAdapters } from "@barry-rocks/sdk/internal/adapters";
import type { InstalledAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import { parseManifest } from "@barry-rocks/sdk/bags";
import { parseBounds } from "@barry-rocks/sdk/internal/identities";
import { mergeBounds, type Bound } from "@barry-rocks/sdk/bounds";

const db = vi.hoisted(() => ({ bound: null as Bound | null }));
vi.mock("./db.js", () => ({
  getSessionRecord: vi.fn(async () => ({
    id: "s",
    identity_id: null,
    bags: [],
    bounds: [],
    bound: db.bound,
    metadata: {},
  })),
}));
vi.mock("./agent-runtime.js", () => ({ getDescribeAdapter: vi.fn() }));
import { getDescribeAdapter } from "./agent-runtime.js";
import { sessionBound, resolveSessionNativeTools } from "./session-agent-guards.js";

let records: InstalledAdapter[];
let namedBounds: Record<string, Bound> = {};

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), "barry-native-api-"));
  vi.stubEnv("BARRY_HOME", root);
  const adapters = loadAdapters({
    file: join(root, "adapters.json"),
    registerBag: async () => {},
  });
  records = await Promise.all(
    ["claude", "cursor", "pi"].map((folder) =>
      adapters.add(new URL(`../../../../adapters/sessions/${folder}`, import.meta.url).pathname),
    ),
  );
  const bash = parseManifest(new URL("../../../bash", import.meta.url).pathname)!;
  const manifests = [...records.map((record) => record.bag!.manifest), bash];
  const baseBounds = Object.fromEntries(
    parseBounds(
      parse(readFileSync(new URL("../../../../identity.yaml", import.meta.url), "utf8")).bounds,
    ).map((entry) => [entry.name, entry.bound!]),
  );
  const manifestBounds = Object.fromEntries(
    manifests.flatMap((manifest) =>
      Object.entries(manifest.bounds ?? {}).flatMap(([name, def]) => [
        [name, def.bound],
        [`${manifest.name}:${name}`, def.bound],
      ]),
    ),
  );
  namedBounds = { ...baseBounds, ...manifestBounds };
  Barry.use(
    fakeIdentities({
      bound: async (_ref, requested) => {
        let acc: Bound | null = null;
        for (const entry of requested ?? []) {
          const next = typeof entry === "string" ? namedBounds[entry] : entry;
          if (!next) throw new Error(`Unknown bound: ${String(entry)}`);
          acc = mergeBounds(acc, next);
        }
        return acc ?? {};
      },
      tools: async () => [],
    }),
  );
  vi.mocked(getDescribeAdapter).mockReturnValue((id) =>
    records.find((record) => record.id === id || record.aliases?.includes(id)),
  );
});

afterEach(() => {
  db.bound = null;
});

afterAll(() => {
  Barry.reset();
  vi.unstubAllEnvs();
});

it("allows native tools by default when unrestricted and withholds <harness>:<ToolName> denials", async () => {
  expect(await sessionBound({ id: "s", provider: "claude" })).toBeNull();
  const open = await resolveSessionNativeTools({ id: "s", provider: "claude" });
  expect(open.allowed).toEqual(expect.arrayContaining(["Read", "Write", "Edit", "Bash"]));
  expect(open.denied).not.toContain("Write");
  expect(open.denied).not.toContain("Edit");

  const noEdit = await resolveSessionNativeTools(
    { id: "s", provider: "claude" },
    { bounds: ["claude:no-file-writes"] },
  );
  expect(noEdit.allowed).toContain("Read");
  expect(noEdit.denied).toEqual(expect.arrayContaining(["Write", "Edit", "NotebookEdit"]));
});

it("takes back native file, network, and shell tools when bounds restrict those domains", async () => {
  db.bound = { network: { deny: ["all"] } };
  const netRestricted = await resolveSessionNativeTools({ id: "s", provider: "claude" });
  expect(netRestricted.denied).toEqual(expect.arrayContaining(["Bash", "WebFetch", "WebSearch"]));

  db.bound = null;
  const noBash = await resolveSessionNativeTools(
    { id: "s", provider: "claude" },
    { bounds: ["bash:no-bash"] },
  );
  expect(noBash.denied).toContain("Bash");
});

it("reports cursor controls and a bound conflict, and withholds pi native tools under bounds", async () => {
  expect(
    (await resolveSessionNativeTools({ id: "s", provider: "cursor" })).uncontrolled,
  ).toHaveProperty("Grep");
  db.bound = { files: { deny: ["**/.env"] } };
  expect(
    (await resolveSessionNativeTools({ id: "s", provider: "cursor" })).conflicts,
  ).toHaveProperty("Grep");
  db.bound = { tools: { deny: ["pi:bash"] } };
  expect(
    (await resolveSessionNativeTools({ id: "s", provider: "pi" })).denied,
  ).toContain("bash");
});
