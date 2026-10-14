import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveAppOutput, isValidAppBundle, buildBagApp, resolveAppBuild } from "../app-build.js";

const BAG = "/bags/demo";

describe("resolveAppOutput", () => {
  it("resolves a bag-relative bundle path", () => {
    expect(resolveAppOutput(BAG, ".build/Demo.app")).toBe("/bags/demo/.build/Demo.app");
  });

  it("refuses a path that escapes the bag", () => {
    expect(resolveAppOutput(BAG, "../../etc/Evil.app")).toBeNull();
  });

  it("refuses an absolute path", () => {
    // Unlike a launchd command — where an absolute path deliberately names a
    // host binary — an app bundle is this bag's own build artifact. Accepting
    // an absolute one would let a manifest have the installer adopt an
    // arbitrary .app and, with login-item set, run it at every login.
    expect(resolveAppOutput(BAG, "/Applications/Evil.app")).toBeNull();
  });

  it("refuses a traversal that lands back inside the bag", () => {
    // Still rejected: allowing it would mean the containment check depends on
    // where the traversal happens to land, which is not a rule anyone can
    // reason about when reviewing a manifest.
    expect(resolveAppOutput(BAG, "../demo/.build/Demo.app")).toBe("/bags/demo/.build/Demo.app");
  });
});

describe("isValidAppBundle", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "app-build-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a directory with Contents/Info.plist", () => {
    const bundle = join(dir, "Demo.app");
    mkdirSync(join(bundle, "Contents"), { recursive: true });
    writeFileSync(join(bundle, "Contents", "Info.plist"), "<plist/>");

    expect(isValidAppBundle(bundle)).toBe(true);
  });

  it("rejects a directory that is not a bundle", () => {
    // A build can exit zero and leave a stray directory. Treating that as a
    // successful build is how a broken app silently stays at its old version.
    const notABundle = join(dir, "Demo.app");
    mkdirSync(notABundle, { recursive: true });

    expect(isValidAppBundle(notABundle)).toBe(false);
  });

  it("rejects a missing path", () => {
    expect(isValidAppBundle(join(dir, "Absent.app"))).toBe(false);
  });

  it("rejects a file", () => {
    const file = join(dir, "Demo.app");
    writeFileSync(file, "not a bundle");

    expect(isValidAppBundle(file)).toBe(false);
  });
});

describe("isValidAppBundle — platform shapes", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "app-build-ios-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A macOS bundle: Info.plist nested under Contents/. */
  function macBundle(name: string): string {
    const b = join(dir, name);
    mkdirSync(join(b, "Contents"), { recursive: true });
    writeFileSync(join(b, "Contents", "Info.plist"), "<plist/>");
    return b;
  }

  /** An iOS bundle: Info.plist at the root, no Contents/ directory at all. */
  function iosBundle(name: string): string {
    const b = join(dir, name);
    mkdirSync(b, { recursive: true });
    writeFileSync(join(b, "Info.plist"), "<plist/>");
    return b;
  }

  it("accepts an iOS bundle with a root Info.plist", () => {
    expect(isValidAppBundle(iosBundle("Phone.app"), "ios")).toBe(true);
  });

  it("rejects a macOS bundle when the app declares ios", () => {
    // The check that stops a naive "accept Info.plist in either location" fix:
    // that version passes the accept-iOS test above while validating nothing,
    // because it would call a macOS bundle a valid iOS one.
    expect(isValidAppBundle(macBundle("Desktop.app"), "ios")).toBe(false);
  });

  it("rejects an iOS bundle when the app declares macos", () => {
    expect(isValidAppBundle(iosBundle("Phone.app"), "macos")).toBe(false);
  });

  it("rejects a bare directory for either platform", () => {
    const bare = join(dir, "Bare.app");
    mkdirSync(bare, { recursive: true });
    expect(isValidAppBundle(bare, "ios")).toBe(false);
    expect(isValidAppBundle(bare, "macos")).toBe(false);
  });
});

describe("semantic app builds", () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "barry-app-script-")); });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
  const app = { name: "demo", description: "Demo app", platform: "macos" as const, build: "build:app", output: "dist/Demo.app" };
  it("executes the declared package script and validates its actual bundle without ambient credentials", async () => {
    writeFileSync(join(directory, "package.json"), JSON.stringify({ packageManager: "npm@11.7.0", scripts: { "build:app": "node build.mjs" } }));
    writeFileSync(join(directory, "build.mjs"), 'import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync("dist/Demo.app/Contents", { recursive: true }); writeFileSync("dist/Demo.app/Contents/Info.plist", "<plist/>"); if(process.env.AMBIENT_BUILD_SECRET) process.exit(23);');
    vi.stubEnv("AMBIENT_BUILD_SECRET", "must-not-reach-build");
    expect(resolveAppBuild(app, directory, join(directory, app.output))).toEqual({ command: "npm", args: ["run", "build:app"] });
    expect(await buildBagApp({ bag: "demo", name: "viewer", app, bagDir: directory, outputPath: join(directory, app.output) })).toMatchObject({ ok: true });
  });
  it.each([
    { scripts: { "build:app": "node build.mjs" } },
    { packageManager: "unknown@1", scripts: { "build:app": "node build.mjs" } },
    { packageManager: "npm@11.7.0", scripts: {} },
  ])("refuses an undeclared package manager or missing script", manifest => {
    writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
    expect(() => resolveAppBuild(app, directory, join(directory, app.output))).toThrow();
  });
  it("reports invalid package metadata without echoing its contents", () => {
    writeFileSync(join(directory, "package.json"), '{private-material-do-not-echo');
    expect(() => resolveAppBuild(app, directory, join(directory, app.output))).toThrow("app build package.json is unreadable or invalid");
  });
  it("rejects a successful package script that produces no bundle", async () => {
    writeFileSync(join(directory, "package.json"), JSON.stringify({ packageManager: "npm@11.7.0", scripts: { "build:app": "node -e \"process.exit(0)\"" } }));
    const result = await buildBagApp({ bag: "demo", name: "viewer", app, bagDir: directory, outputPath: join(directory, app.output) });
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain("produced no bundle");
  });
  it("resolves an explicit Xcode build with the authored scheme, configuration and output directory", () => {
    mkdirSync(join(directory, "Demo.xcodeproj"));
    const xcode = { ...app, name: "../unsafe display label", build: { project: "Demo.xcodeproj", scheme: "Demo", configuration: "Release" } };
    expect(resolveAppBuild(xcode, directory, join(directory, app.output))).toEqual({ command: "xcodebuild", args: [
      "-project", join(directory, "Demo.xcodeproj"), "-scheme", "Demo", "-configuration", "Release",
      "-derivedDataPath", expect.stringMatching(/\/\.build-barry-app\/[a-f0-9]{16}$/), `CONFIGURATION_BUILD_DIR=${join(directory, "dist")}`, "build",
    ] });
  });
});

it("refuses output paths reached through a symlink outside the bag", () => {
  const directory = mkdtempSync(join(tmpdir(), "barry-app-link-"));
  try {
    const bag = join(directory, "bag");
    const outside = join(directory, "outside");
    mkdirSync(bag); mkdirSync(outside);
    symlinkSync(outside, join(bag, "dist"));
    expect(resolveAppOutput(bag, "dist/Demo.app")).toBeNull();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
