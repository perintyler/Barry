import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkRelease, checkReleaseDirectory } from "./check.js";
import * as build from "./build.js";
import * as current from "./current.js";

const roots: string[] = [];
const probe = { node: { version: "26.11.1", sha256: "a".repeat(64) }, stores: { "core/config": 1 }, problems: [] };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "barry-release-verdict-")); roots.push(root);
  for (const file of ["bin/barry", "runtime/bin/node"]) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  // A Homebrew interpreter depends on dylibs beside it; copying just its
  // executable breaks this fixture. A wrapper preserves that installation.
  writeFileSync(join(root, "runtime/bin/node"), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
  mkdirSync(join(root, "cli/dist"), { recursive: true });
  for (const file of ["barry.js", "identity.js", "barry-hook.js", "build.json"]) writeFileSync(join(root, "cli/dist", file), "{}");
  mkdirSync(join(root, "cli/bin"), { recursive: true });
  writeFileSync(join(root, "cli/bin/barry.js"), 'console.log("1.0.0"); if (process.env.BARRY_TIMING === "1") console.error("entry: bundle");\n');
  writeFileSync(join(root, "bin/barry"), '#!/bin/sh\nexec "$(dirname "$0")/../runtime/bin/node" "$(dirname "$0")/../cli/bin/barry.js" "$@"\n', { mode: 0o755 });
  const release = { version: "1.0.0", commit: "b".repeat(40), platform: "darwin-arm64", node: probe.node, stores: probe.stores, built: "2026-10-09T00:00:00.000Z" };
  const save = () => writeFileSync(join(root, "release.json"), JSON.stringify(release));
  writeFileSync(join(root, "cli/dist/build.json"), JSON.stringify({ commit: release.commit }));
  save(); return { root, release, save };
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("release directory verdict", () => {
  it("accepts consistent metadata and the pre-metadata build probe", () => {
    const { root } = fixture(); expect(checkReleaseDirectory(root, probe)).toEqual([]);
    rmSync(join(root, "release.json")); expect(checkReleaseDirectory(root, probe)).toEqual([]);
  });
  it("rejects invalid metadata", () => {
    const { root } = fixture(); writeFileSync(join(root, "release.json"), "{}");
    expect(checkReleaseDirectory(root, probe).join(" ")).toContain("release.json");
  });
  it.each(["bin/barry", "runtime/bin/node"])("rejects non-executable %s", file => {
    const { root } = fixture(); chmodSync(join(root, file), 0o644);
    expect(checkReleaseDirectory(root, probe).join(" ")).toContain("must be executable");
  });
  it("rejects an escaping symlink", () => {
    const { root } = fixture(); symlinkSync(tmpdir(), join(root, "escape"));
    expect(checkReleaseDirectory(root, probe).join(" ")).toContain("escapes its root");
  });
  it("rejects a mismatched runtime digest", () => {
    const f = fixture(); f.release.node = { ...probe.node, sha256: "c".repeat(64) }; f.save();
    expect(checkReleaseDirectory(f.root, probe).join(" ")).toContain("runtime differs");
  });
  it("rejects a mismatched migration catalog", () => {
    const f = fixture(); f.release.stores = { "core/config": 2 }; f.save();
    expect(checkReleaseDirectory(f.root, probe).join(" ")).toContain("stores catalog differs");
  });
  it("rejects a release whose checkout-link guard accepts it", () => {
    const { root } = fixture();
    vi.spyOn(current, "linkCheckout").mockReturnValue({ root, node: join(root, "runtime/bin/node") });
    expect(checkReleaseDirectory(root, probe).join(" ")).toContain("release was accepted as a linked checkout");
  });
  it("rejects a mismatched direct CLI version even if the wrapper reports the expected version", () => {
    const { root } = fixture();
    writeFileSync(join(root, "cli/bin/barry.js"), 'console.log("0.9.0");\n');
    writeFileSync(join(root, "bin/barry"), '#!/bin/sh\nprintf "1.0.0\\n"\n', { mode: 0o755 });
    expect(checkReleaseDirectory(root, probe).join(" ")).toContain("cli/bin/barry.js --version differs from release.json");
  });
  it("rejects a broken wrapper even when the direct CLI version matches", () => {
    const { root } = fixture();
    writeFileSync(join(root, "bin/barry"), '#!/bin/sh\nprintf "0.9.0\\n"\n', { mode: 0o755 });
    expect(checkReleaseDirectory(root, probe).join(" ")).toContain("bin/barry --version differs from release.json");
  });
  it("rejects a shipped CLI version differing from release metadata", async () => {
    const { root } = fixture();
    vi.spyOn(build, "run").mockImplementation((command, args) => {
      if (command === "tar" && args[0] === "-tzf") return "fixture/\n";
      if (command === "tar" && args[0] === "-xzf") { cpSync(root, join(args[args.indexOf("-C") + 1], "fixture"), { recursive: true }); return ""; }
      if (command === "/usr/bin/codesign") return "";
      if (args[0] === "--version") return "0.9.0\n";
      throw new Error(`unexpected release check command: ${command} ${args.join(" ")}`);
    });
    await expect(checkRelease(join(root, "fixture.tar.gz"))).rejects.toThrow("barry --version differs from release.json");
  });
});

it("rejects a bundle from another commit", () => {
  const { root } = fixture();
  writeFileSync(join(root, "cli/dist/build.json"), JSON.stringify({ commit: "c".repeat(40) }));
  expect(checkReleaseDirectory(root, probe).join(" ")).toContain("CLI bundle commit differs");
});
