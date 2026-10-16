import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bagDataDir,
  bagSegment,
  bagLogsDir,
  barryAdaptersPath,
  barryModelVendorsPath,
  barryAppSupportDir,
  barryConfigDir,
  barryEnvPath,
  barryLogsDir,
  barryRunDir,
} from "./home.mjs";

afterEach(() => vi.unstubAllEnvs());

function scratchHome(): string {
  return mkdtempSync(join(tmpdir(), "barry-home-test-"));
}

describe("an instance is a home", () => {
  it("computes metadata paths without creating instance state", () => {
    const home = join(scratchHome(), "unconfigured-instance");
    vi.stubEnv("BARRY_HOME", home);
    expect(bagDataDir("vault", { create: false })).toBe(join(home, "app-support", "data", "vault"));
    expect(existsSync(home)).toBe(false);
  });
  it("puts every location under BARRY_HOME when it is set", () => {
    const home = scratchHome();
    vi.stubEnv("BARRY_HOME", home);
    expect(barryAppSupportDir()).toBe(join(home, "app-support"));
    expect(barryLogsDir()).toBe(join(home, "logs"));
    expect(barryConfigDir()).toBe(join(home, "config"));
    expect(barryEnvPath()).toBe(join(home, "app-support", "env"));
    expect(barryAdaptersPath()).toBe(join(home, "app-support", "adapters.json"));
    expect(barryModelVendorsPath()).toBe(join(home, "app-support", "model-providers.json"));
    expect(bagLogsDir("sessions")).toBe(join(home, "logs", "sessions"));
  });

  it("maps an extension to one collision-free segment for data and logs", () => {
    const home = scratchHome();
    vi.stubEnv("BARRY_HOME", home);
    expect(bagSegment("sessions/search")).toBe("sessions+search");
    expect(bagDataDir("sessions/search")).toBe(join(home, "app-support", "data", "sessions+search"));
    expect(bagLogsDir("sessions/search")).toBe(join(home, "logs", "sessions+search"));
    expect(() => bagSegment("sessions+search")).toThrow();
  });

  it("gives each bag its own data directory, created private to the user", () => {
    const home = scratchHome();
    vi.stubEnv("BARRY_HOME", home);
    const dir = bagDataDir("sessions");
    expect(dir).toBe(join(home, "app-support", "data", "sessions"));
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("refuses to create a store in the real instance from a test with no BARRY_HOME", () => {
    // HOME points somewhere disposable, so a broken guard creates its
    // directory there and not in this machine's real instance.
    const fakeUser = scratchHome();
    vi.stubEnv("HOME", fakeUser);
    vi.stubEnv("BARRY_HOME", "");
    expect(() => bagDataDir("sessions")).toThrow(/real instance/);
    expect(existsSync(join(fakeUser, "Library"))).toBe(false);
  });

  it("refuses a bag name that would reach outside its own directory", () => {
    vi.stubEnv("BARRY_HOME", scratchHome());
    for (const name of ["../sessions", "a/b/c", "../x", "", ".hidden", "x..y"]) {
      expect(() => bagDataDir(name), name).toThrow(/bag name/);
      expect(() => bagLogsDir(name), name).toThrow(/bag name/);
    }
  });

  it("honours XDG_CONFIG_HOME for the files a person edits, but only an absolute one", () => {
    vi.stubEnv("BARRY_HOME", "");
    vi.stubEnv("XDG_CONFIG_HOME", "/tmp/xdg");
    expect(barryConfigDir()).toBe("/tmp/xdg/barry");
    vi.stubEnv("XDG_CONFIG_HOME", "relative/path");
    expect(barryConfigDir()).toMatch(/\/\.config\/barry$/);
  });

  it("keeps two instances' runtime sockets apart, within the macOS socket path limit", () => {
    vi.stubEnv("BARRY_HOME", "/tmp/one");
    const one = barryRunDir();
    vi.stubEnv("BARRY_HOME", "/tmp/two");
    const two = barryRunDir();
    expect(one).not.toBe(two);
    expect(join(one, "fixture.sock").length).toBeLessThan(104);
  });

  it("honours an explicit temporary directory for runtime sockets", () => {
    vi.stubEnv("BARRY_HOME", "/tmp/one");
    const temporaryDirectory = scratchHome();
    vi.stubEnv("TMPDIR", temporaryDirectory);
    const runDirectory = barryRunDir();
    expect(dirname(runDirectory)).toBe(temporaryDirectory);
    expect(basename(runDirectory)).toMatch(/^barry-[0-9a-f]{8}$/);
  });

  it.skipIf(process.platform !== "darwin")("finds the native runtime directory with or without macOS TMPDIR", () => {
    vi.stubEnv("BARRY_HOME", "/tmp/one");
    const nativeTemporaryDirectory = execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim();
    vi.stubEnv("TMPDIR", nativeTemporaryDirectory);
    const withTmpdir = barryRunDir();
    vi.stubEnv("TMPDIR", "");
    expect(barryRunDir()).toBe(withTmpdir);
  });
});
