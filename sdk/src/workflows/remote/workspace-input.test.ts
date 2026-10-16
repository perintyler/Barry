import {
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
import { afterEach, describe, expect, it } from "vitest";
import { WorkArtifactStore } from "../work-artifacts.js";
import {
  materializeIsolatedWorkspace,
  prepareWorkspaceInputBundle,
  readWorkspaceInputBundle,
  scanWorkspaceTree,
  validateWorkspaceRelativePath,
} from "./workspace-input.js";

const roots: string[] = [];
const stores: WorkArtifactStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createTempRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "workspace-input-test-")));
  roots.push(dir);
  return dir;
}

describe("workspace-input", () => {
  it("rejects path traversal, absolute paths, backslashes, NUL bytes, and forbidden secret paths", () => {
    expect(validateWorkspaceRelativePath("src/index.ts")).toBe("src/index.ts");
    expect(() => validateWorkspaceRelativePath("../escape.ts")).toThrow(/forbidden segment/);
    expect(() => validateWorkspaceRelativePath("src/../../escape.ts")).toThrow(/forbidden segment/);
    expect(() => validateWorkspaceRelativePath("/etc/passwd")).toThrow(/Invalid workspace relative path/);
    expect(() => validateWorkspaceRelativePath("C:/Windows/system32")).toThrow(
      /Invalid workspace relative path/,
    );
    expect(() => validateWorkspaceRelativePath("src\\index.ts")).toThrow(
      /Invalid workspace relative path/,
    );
    expect(() => validateWorkspaceRelativePath("src/\0bad.ts")).toThrow(
      /Invalid workspace relative path/,
    );
    expect(() => validateWorkspaceRelativePath(".env")).toThrow(/forbidden secret/);
    expect(() => validateWorkspaceRelativePath("config/.env.production")).toThrow(
      /forbidden secret/,
    );
    expect(() => validateWorkspaceRelativePath(".ssh/id_ed25519")).toThrow(/forbidden secret/);
    expect(() => validateWorkspaceRelativePath(".barry/credentials.json")).toThrow(
      /forbidden secret/,
    );
  });

  it("prepares, verifies, and materializes an isolated workspace input bundle into a private 0700 directory", () => {
    const root = createTempRoot();
    const store = new WorkArtifactStore(join(root, "artifacts"));
    stores.push(store);

    const prepared = prepareWorkspaceInputBundle({
      artifacts: store,
      resource_ref: "workspace:isolated-demo",
      files: [
        { path: "README.md", content: "# Demo Workspace\n" },
        { path: "scripts/run.sh", content: "#!/bin/sh\necho ok\n", executable: true },
        { path: "src/app.ts", content: "export const value = 42;\n" },
      ],
    });

    const rawBytes = store.verify(prepared.artifact);
    const verified = readWorkspaceInputBundle(rawBytes, {
      expectedResourceRef: "workspace:isolated-demo",
      expectedBaseDigest: prepared.bundle.base_digest,
    });
    expect(verified.decodedFiles).toHaveLength(3);

    const isolatedParent = join(root, "isolated-parent");
    mkdirSync(isolatedParent, { mode: 0o700 });

    const materialized = materializeIsolatedWorkspace({
      isolatedParentRoot: isolatedParent,
      bundleBytes: rawBytes,
      writable: true,
      expectedResourceRef: "workspace:isolated-demo",
      expectedBaseDigest: prepared.bundle.base_digest,
    });

    expect(materialized.base_digest).toBe(prepared.bundle.base_digest);
    expect(readFileSync(join(materialized.canonical_root, "src/app.ts"), "utf8")).toBe(
      "export const value = 42;\n",
    );
  });

  it("rejects duplicate paths, case collisions, file/directory conflicts, tampered digests, and oversized bundles", () => {
    const root = createTempRoot();
    const store = new WorkArtifactStore(join(root, "artifacts"));
    stores.push(store);

    // Duplicate path
    expect(() =>
      prepareWorkspaceInputBundle({
        artifacts: store,
        resource_ref: "ws:dup",
        files: [
          { path: "src/a.ts", content: "1" },
          { path: "src/a.ts", content: "2" },
        ],
      }),
    ).toThrow(/Duplicate workspace file path/);

    // Case-colliding path
    expect(() =>
      prepareWorkspaceInputBundle({
        artifacts: store,
        resource_ref: "ws:case",
        files: [
          { path: "src/File.ts", content: "1" },
          { path: "src/file.ts", content: "2" },
        ],
      }),
    ).toThrow(/Case-colliding workspace file path/);

    // File/directory ancestor conflict
    expect(() =>
      prepareWorkspaceInputBundle({
        artifacts: store,
        resource_ref: "ws:conflict",
        files: [
          { path: "src/module", content: "file" },
          { path: "src/module/index.ts", content: "nested" },
        ],
      }),
    ).toThrow(/file\/directory path conflict/);

    // Tampered file content digest in serialized bundle
    const good = prepareWorkspaceInputBundle({
      artifacts: store,
      resource_ref: "ws:tamper",
      files: [{ path: "src/a.ts", content: "original" }],
    });
    const tamperedBundle = {
      ...good.bundle,
      files: [
        {
          ...good.bundle.files[0]!,
          data: Buffer.from("tampered!").toString("base64"),
        },
      ],
    };
    expect(() =>
      readWorkspaceInputBundle(Buffer.from(JSON.stringify(tamperedBundle), "utf8")),
    ).toThrow(/byte count|digest/);

    // Oversized file limit
    expect(() =>
      prepareWorkspaceInputBundle({
        artifacts: store,
        resource_ref: "ws:big",
        files: [{ path: "big.bin", content: Buffer.alloc(1024) }],
        maxFileBytes: 512,
      }),
    ).toThrow(/exceeds limit/);
  });

  it("rejects symlinks and hardlinks when scanning workspace trees", () => {
    const root = createTempRoot();
    const wsDir = join(root, "ws");
    mkdirSync(wsDir, { mode: 0o700 });
    const fileA = join(wsDir, "a.txt");
    writeFileSync(fileA, "hello", { mode: 0o600 });

    // Clean scan succeeds
    const clean = scanWorkspaceTree(wsDir);
    expect(clean.files).toHaveLength(1);

    // Symlink inside workspace is rejected
    const symlinkPath = join(wsDir, "escape-link.txt");
    symlinkSync(fileA, symlinkPath);
    expect(() => scanWorkspaceTree(wsDir)).toThrow(/symbolic link/);
    rmSync(symlinkPath);

    // Hardlink inside workspace is rejected by default
    const hardlinkPath = join(wsDir, "hardlink.txt");
    linkSync(fileA, hardlinkPath);
    expect(() => scanWorkspaceTree(wsDir)).toThrow(/hardlink count/);
  });
});
