import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from "fs";
import { join, relative } from "path";
import { tmpdir } from "os";
import { parse } from "yaml";
import { fileURLToPath } from "url";
import { scaffoldBag } from "../scaffold.js";

// sdk/src/bags/__tests__ -> this package's own root. The scaffolder reads
// its own manifest now that it lives inside the merged package, so this reads
// the same file rather than restating a hop to a sibling that no longer exists.
// The SDK's package: what a scaffolded npm bag depends on.
const packageRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..", "sdk");

describe("scaffold", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) {
      rmSync(d, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it("creates bag directory with manifest", () => {
    const parent = mkdtempSync(join(tmpdir(), "scaffold-"));
    tmpDirs.push(parent);
    const bagPath = join(parent, "my-bag");

    scaffoldBag({ name: "my-bag", description: "Test", path: bagPath });

    expect(existsSync(join(bagPath, "bag.yaml"))).toBe(true);
    expect(existsSync(join(bagPath, "skills"))).toBe(true);

    const manifest = parse(readFileSync(join(bagPath, "bag.yaml"), "utf-8"));
    expect(manifest.version).toBe("v0.1");
    expect(manifest.name).toBe("my-bag");
    expect(manifest.description).toBe("Test");
    expect(manifest.traits).toBeUndefined();
  });

  it("includes server section when withServer is true", () => {
    const parent = mkdtempSync(join(tmpdir(), "scaffold-"));
    tmpDirs.push(parent);
    const bagPath = join(parent, "server-bag");

    scaffoldBag({ name: "server-bag", path: bagPath, withServer: true });

    const manifest = parse(readFileSync(join(bagPath, "bag.yaml"), "utf-8"));
    expect(manifest.server).toBeDefined();
    expect(manifest.server.entry).toBe("server.ts");
    expect(manifest.server.port).toBeUndefined();
  });

  it("generates server files when withServer is true", () => {
    const parent = mkdtempSync(join(tmpdir(), "scaffold-"));
    tmpDirs.push(parent);
    const bagPath = join(parent, "server-files");

    scaffoldBag({ name: "server-files", path: bagPath, withServer: true });

    expect(existsSync(join(bagPath, "server.ts"))).toBe(true);
    expect(existsSync(join(bagPath, "package.json"))).toBe(true);
    expect(existsSync(join(bagPath, "tsconfig.json"))).toBe(true);

    const pkg = JSON.parse(readFileSync(join(bagPath, "package.json"), "utf-8"));
    // The dependency KEY is the package; the subpath belongs in imports only.
    expect(pkg.dependencies["@barry-rocks/sdk"]).toBeDefined();
    expect(pkg.dependencies["@barry-rocks/sdk/tools"]).toBeUndefined();
    expect(pkg.dependencies["@modelcontextprotocol/sdk"]).toBeUndefined();

    const serverContent = readFileSync(join(bagPath, "server.ts"), "utf-8");
    expect(serverContent).toContain("startBagServer");
    expect(serverContent).toContain("defineTool");
  });

  it("does not generate server files without withServer", () => {
    const parent = mkdtempSync(join(tmpdir(), "scaffold-"));
    tmpDirs.push(parent);
    const bagPath = join(parent, "no-server");

    scaffoldBag({ name: "no-server", path: bagPath });

    expect(existsSync(join(bagPath, "server.ts"))).toBe(false);
    expect(existsSync(join(bagPath, "package.json"))).toBe(false);
  });

  it("throws if directory already exists", () => {
    const parent = mkdtempSync(join(tmpdir(), "scaffold-"));
    tmpDirs.push(parent);

    expect(() => scaffoldBag({ name: "dup", path: parent })).toThrow("already exists");
  });

  // The npm template is the only path an external author takes, and its
  // dependency range is the one thing that must resolve from a repo with no
  // access to this workspace. Comparing against the SDK's own manifest is what
  // makes this fail when the SDK majors and the scaffolder is left behind; a
  // literal here would just drift alongside the bug.
  it("scaffolds the npm template against the SDK's current major", () => {
    const parent = mkdtempSync(join(tmpdir(), "scaffold-"));
    tmpDirs.push(parent);
    const bagPath = join(parent, "npm-bag");

    scaffoldBag({ name: "npm-bag", path: bagPath, withServer: true, template: "npm" });

    const pkg = JSON.parse(readFileSync(join(bagPath, "package.json"), "utf-8"));
    const sdkVersion = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf-8"),
    ).version;

    expect(pkg.dependencies["@barry-rocks/sdk"]).toBe(`^${sdkVersion}`);
    // The `bags-sdk` facade was folded into this package; nothing should still
    // scaffold against that name.
    expect(pkg.dependencies["@barry-rocks/bags-sdk"]).toBeUndefined();
    // workspace:/link: specifiers cannot resolve outside this repo.
    expect(pkg.dependencies["@barry-rocks/sdk"]).not.toMatch(/^(workspace:|link:)/);
  });
});

it("links external bags to the SDK through current", () => {
  const home = mkdtempSync(join(tmpdir(), "barry-scaffold-current-"));
  vi.stubEnv("BARRY_HOME", home);
  try {
    mkdirSync(join(home, "app-support"), { recursive: true });
    mkdirSync(join(home, "target/sdk"), { recursive: true });
    writeFileSync(join(home, "target/sdk/package.json"), '{"version":"1.0.0"}');
    symlinkSync(join(home, "target"), join(home, "app-support/current"));
    const path = join(home, "external");
    scaffoldBag({ name: "external", path, withServer: true });
    const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
    expect(pkg.dependencies["@barry-rocks/sdk"]).toBe(`link:${relative(path, join(home, "app-support/current/sdk"))}`);
    const internal = join(home, "target/bags/internal");
    scaffoldBag({ name: "internal", path: internal, withServer: true });
    expect(JSON.parse(readFileSync(join(internal, "package.json"), "utf8")).dependencies["@barry-rocks/sdk"]).toBe("workspace:*");
  } finally { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); }
});
