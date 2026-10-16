import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { registerWork } from "./work.js";
import { inventoryWorkOps, verifyWorkOpsFiles } from "./work-ops.js";
import { runWorkOps } from "./work-ops-cli.js";

const roots: string[] = [];
afterEach(() => {
  process.exitCode = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "work-ops-")));
  roots.push(root);
  return root;
}
const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const manifest = (path = "agentArtifact", bytes = "accepted bytes") => ({
  version: 1,
  scope: "local-file-verification",
  members: [{ path, bytes: Buffer.byteLength(bytes), sha256: digest(bytes) }],
});
const spec = (path: string) => ({
  version: 1,
  roots: [
    {
      id: "worker",
      path,
      role: "worker",
      owner: "owner",
      bindings: ["owner:sessions", "host-broker", "endpoint-broker"],
    },
  ],
  credentials: [],
});

it("finds nested stores, retained pins and spool output without implying a consistent recovery point", () => {
  const root = fixture();
  mkdirSync(join(root, "authority", "spool"), { recursive: true });
  for (const file of [
    "accepted-work.sqlite",
    "accepted-work.sqlite-wal",
    "agentArtifact",
    "result.json",
    ".executor-retained",
  ])
    writeFileSync(join(root, "authority", "spool", file), "kept");
  const result = inventoryWorkOps(spec(root));
  expect(result.files).toHaveLength(5);
  expect(result.totals.walBytes).toBe(4);
  expect(result.roots[0].bindings).toContain("endpoint-broker");
  expect(result).toMatchObject({ complete: false, restoreReady: false, recoveryPoint: null });
  expect(readFileSync(join(root, "authority", "spool", "result.json"), "utf8")).toBe("kept");
});

it("reports missing arbitrary worker roots and inventory exhaustion instead of silently skipping them", () => {
  const root = fixture();
  writeFileSync(join(root, "one"), "1");
  expect(inventoryWorkOps(spec(join(root, "absent"))).issues).toHaveLength(1);
  expect(inventoryWorkOps(spec(root), 1).issues).toHaveLength(1);
});

it("refuses overlapping roots instead of double-counting retained bytes", () => {
  const root = fixture();
  mkdirSync(join(root, "authority"));
  const parent = spec(root).roots[0];
  for (const path of [root, join(root, "authority")]) {
    expect(() =>
      inventoryWorkOps({
        version: 1,
        roots: [parent, { ...parent, id: "nested", path }],
        credentials: [],
      }),
    ).toThrow();
  }
  expect(() => inventoryWorkOps(spec(root + "/../other"))).toThrow();
});

it("treats credentials under the filesystem root as enclosed without scanning it", () => {
  const result = inventoryWorkOps({
    ...spec("/"),
    credentials: [{ id: "root-credential", path: "/private/credential-reference", owner: "owner" }],
  });
  expect(result.files).toEqual([]);
  expect(result.issues).toEqual([{ code: "CredentialInsideRoot", root: "worker" }]);
});

it("does not follow links or traverse credential roots", () => {
  const root = fixture(),
    outside = fixture();
  writeFileSync(join(outside, "secret"), "NEVER_PRINT");
  symlinkSync(outside, join(root, "linked"));
  expect(inventoryWorkOps(spec(root)).issues).toHaveLength(1);
  const result = inventoryWorkOps({
    ...spec(outside),
    credentials: [{ id: "worker-bearer", path: join(outside, "secret"), owner: "owner" }],
  });
  expect(result.files).toEqual([]);
  expect(result.issues[0].code).toBe("CredentialInsideRoot");
  expect(JSON.stringify(result)).not.toContain("NEVER_PRINT");
});

it("verifies exact agentArtifact bytes but keeps completeness blocked even with all supplied members", () => {
  const root = fixture();
  writeFileSync(join(root, "agentArtifact"), "accepted bytes");
  expect(verifyWorkOpsFiles(root, manifest())).toMatchObject({
    filesVerified: true,
    complete: false,
    restoreReady: false,
    recoveryPoint: null,
  });
  writeFileSync(join(root, "agentArtifact"), "corrupt! bytes!");
  expect(verifyWorkOpsFiles(root, manifest()).filesVerified).toBe(false);
  rmSync(join(root, "agentArtifact"));
  expect(verifyWorkOpsFiles(root, manifest()).issues[0].code).toBe("MemberUnavailableOrUnsafe");
});

it.each(["../escape", "/absolute", "a/../../escape", "a/./member", "a//member"])(
  "refuses unsafe manifest member %s",
  (path) => {
    expect(verifyWorkOpsFiles(fixture(), manifest(path)).filesVerified).toBe(false);
  },
);

it("refuses symlink ancestors and hardlinked backup members", () => {
  const root = fixture(),
    outside = fixture();
  writeFileSync(join(outside, "blob"), "accepted bytes");
  symlinkSync(outside, join(root, "alias"));
  expect(verifyWorkOpsFiles(root, manifest("alias/blob")).filesVerified).toBe(false);
  linkSync(join(outside, "blob"), join(root, "hardlink"));
  expect(verifyWorkOpsFiles(root, manifest("hardlink")).filesVerified).toBe(false);
});

it("rejects caller assertions of completeness and duplicate members", () => {
  const root = fixture();
  expect(() => verifyWorkOpsFiles(root, { ...manifest(), complete: true })).toThrow();
  expect(() =>
    verifyWorkOpsFiles(root, {
      ...manifest(),
      members: [...manifest().members, ...manifest().members],
    }),
  ).toThrow();
});

it("cannot publish or return success as an installation backup verifier", () => {
  const root = fixture(),
    path = join(root, "manifest.json");
  writeFileSync(join(root, "agentArtifact"), "accepted bytes");
  writeFileSync(path, JSON.stringify(manifest()));
  expect(runWorkOps(["verify-files", root, path]).exitCode).toBe(2);
  expect(existsSync(join(root, "COMPLETE"))).toBe(false);
});

it("registers work ops subcommands on the central work command and redacts refused inputs", async () => {
  const root = fixture(),
    path = join(root, "manifest.json");
  writeFileSync(join(root, "agentArtifact"), "accepted bytes");
  writeFileSync(path, JSON.stringify(manifest()));
  const program = new Command();
  registerWork(program);
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await program.parseAsync(["node", "barry", "work", "ops", "verify-files", root, path]);
    expect(process.exitCode).toBe(2);
    expect(log).toHaveBeenCalledTimes(1);
    const BadPath = join(root, "secret-value-not- echoed.json");
    writeFileSync(BadPath, "{not-json: SECRET_TOKEN_123}");
    await expect(
      program.parseAsync(["node", "barry", "work", "ops", "inventory", BadPath]),
    ).rejects.toThrow("WorkOpsRefused:");
    expect(process.exitCode).toBe(1);
  } finally {
    log.mockRestore();
  }
});
