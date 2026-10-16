import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  statSync,
  writeFileSync,
  rmSync,
  chmodSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createProcessWorkWorker } from "./work-process-worker.js";
import {
  computeWorkspaceMappingDigest,
  readProcessWorkHostConfig,
  runProcessWorkHost,
  processWorkHostConfigSchema,
  scanWorkspaceTree,
  verifyProcessWorkHostRemoteSetup,
} from "./work-process-host.js";
import { inspectArtifact } from "./artifacts.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "process-work-host-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const credential = join(root, "credential");
  writeFileSync(credential, "barry_wk_host-fixture", { mode: 0o600 });
  const artifact = inspectArtifact(
    fileURLToPath(new URL("./execution-fixture.mjs", import.meta.url)),
    "echo",
    "1",
  );
  return {
    root,
    credential,
    config: {
      version: 1 as const,
      installation: "host",
      directory: root,
      artifact_root: join(root, "artifacts"),
      owners: [{ id: "owner", url: "http://127.0.0.1:1", credential_file: credential }],
      activities: [{ type: "echo", source: artifact.path, digest: artifact.digest }],
      capacity: 1,
      labels: {},
    },
  };
}
it("process host: validates trusted bounded configuration and refuses credential-bearing or plaintext remote URLs", () => {
  const f = fixture(),
    path = join(f.root, "host.json");
  writeFileSync(path, JSON.stringify(f.config));
  expect(readProcessWorkHostConfig(path)).toMatchObject(f.config);
  expect(readProcessWorkHostConfig(path)).toMatchObject({
    max_artifact_bytes: 33554432,
    activities: [{ kind: "module" }],
  });
  for (const url of [
    "http://example.com",
    "https://secret@example.com",
    "https://example.com/?secret=token",
    "file:///tmp/owner",
  ]) {
    expect(
      processWorkHostConfigSchema.safeParse({
        ...f.config,
        owners: [{ ...f.config.owners[0], url }],
      }).success,
    ).toBe(false);
  }
  writeFileSync(path, JSON.stringify({ ...f.config, confidential: "do-not-echo" }));
  expect(() => readProcessWorkHostConfig(path)).toThrow("configuration is unreadable or invalid");
  expect(
    processWorkHostConfigSchema.safeParse({
      ...f.config,
      owners: [...f.config.owners, ...f.config.owners],
    }).success,
  ).toBe(false);
});
it.each(["public", "symlink", "oversized", "invalid"])(
  "process host: refuses %s credentials without exposing their contents",
  async variant => {
    const f = fixture();
    if (variant === "public") chmodSync(f.credential, 0o644);
    else if (variant === "symlink") {
      const link = join(f.root, "link");
      symlinkSync(f.credential, link);
      f.config.owners[0]!.credential_file = link;
    } else
      writeFileSync(
        f.credential,
        variant === "oversized" ? "secret".repeat(1000) : "sensitive-invalid-value",
      );
    await expect(
      runProcessWorkHost(f.config, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      code: "WorkHostConfigurationInvalid",
      message: "Process host configuration or private worker credentials are invalid.",
    });
  },
);
it("process host: an aborted launch performs no worker startup", async () => {
  const f = fixture();
  let ready = false;
  await runProcessWorkHost(f.config, {
    signal: AbortSignal.abort(),
    onReady: () => {
      ready = true;
    },
  });
  expect(ready).toBe(false);
});
it("process host: journal lifetime ownership refuses a second host and releases on close", async () => {
  const f = fixture(),
    options = {
      installation: "host",
      journalPath: join(f.root, "executor.db"),
      artifactRoot: f.config.artifact_root,
      connections: [],
      advertisement: { types: ["echo"] },
    };
  const first = createProcessWorkWorker(options);
  cleanups.push(() => first.close());
  expect(() => createProcessWorkWorker(options)).toThrow(/locked/);
  await first.close();
  expect(() => createProcessWorkWorker({ ...options, capacity: 0 })).toThrow();
  const replacement = createProcessWorkWorker(options);
  cleanups.push(() => replacement.close());
  await replacement.close();
});

it("process host: changed installed code refuses startup before it can advertise", async () => {
  const f = fixture();
  let ready = false;
  await expect(
    runProcessWorkHost(
      { ...f.config, activities: [{ ...f.config.activities[0]!, digest: "0".repeat(64) }] },
      {
        signal: new AbortController().signal,
        onReady: () => {
          ready = true;
        },
      },
    ),
  ).rejects.toMatchObject({ code: "WorkHostArtifactUnavailable" });
  expect(ready).toBe(false);
});

it("process host: validates remote workspace mappings, device/inode stability, and rejects duplicate or cross-installation mappings", () => {
  const f = fixture();
  const wsDir = join(f.root, "verified-ws");
  mkdirSync(wsDir, { mode: 0o700 });
  writeFileSync(join(wsDir, "file.txt"), "hello\n", { mode: 0o600 });
  const wsStat = statSync(wsDir);
  const snap = scanWorkspaceTree(wsDir);

  const entryBase = {
    version: 1 as const,
    resource_ref: "repo:verified",
    mapping_version: 1,
    worker_installation: "host",
    canonical_root: wsDir,
    dev: wsStat.dev,
    ino: wsStat.ino,
    writable_allowed: true,
    expected_base_digest: snap.tree_digest,
  };
  const mappingDigest = computeWorkspaceMappingDigest(entryBase);
  const validRemoteConfig = {
    ...f.config,
    remote: {
      enabled: true,
      staging_root: join(f.root, "staging"),
      isolated_workspace_root: join(f.root, "isolated"),
      containment_posture: "portable-pgid" as const,
      workspaces: [{ ...entryBase, mapping_digest: mappingDigest }],
    },
  };

  const parsed = processWorkHostConfigSchema.parse(validRemoteConfig);
  const { lockStore } = verifyProcessWorkHostRemoteSetup(parsed);
  expect(lockStore).not.toBeNull();
  lockStore?.close();

  // Rejects mismatched worker_installation in workspace entry
  expect(
    processWorkHostConfigSchema.safeParse({
      ...validRemoteConfig,
      remote: {
        ...validRemoteConfig.remote,
        workspaces: [{ ...entryBase, worker_installation: "wrong-host" }],
      },
    }).success,
  ).toBe(false);

  // Rejects duplicate resource_ref
  expect(
    processWorkHostConfigSchema.safeParse({
      ...validRemoteConfig,
      remote: {
        ...validRemoteConfig.remote,
        workspaces: [
          { ...entryBase, mapping_digest: mappingDigest },
          { ...entryBase, canonical_root: join(f.root, "other"), mapping_digest: mappingDigest },
        ],
      },
    }).success,
  ).toBe(false);

  // Rejects wrong inode in verifyProcessWorkHostRemoteSetup
  const badInodeConfig = processWorkHostConfigSchema.parse({
    ...validRemoteConfig,
    remote: {
      ...validRemoteConfig.remote,
      workspaces: [{ ...entryBase, ino: wsStat.ino + 999 }],
    },
  });
  expect(() => verifyProcessWorkHostRemoteSetup(badInodeConfig)).toThrow(/device\/inode/);
});
