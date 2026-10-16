import { afterEach, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, symlinkSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkArtifactStore } from "./work-artifacts.js";
import { prepareProcessBundle, materializeProcessBundle, readProcessBundle } from "./work-process-bundle.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "process-bundle-")); roots.push(root);
  const source = join(root, "main.sh"); writeFileSync(source, "printf retained"); chmodSync(source, 0o755);
  const artifacts = new WorkArtifactStore(join(root, "artifacts"));
  return { root, source, artifacts };
}
it("retains exact executable bytes, deterministic names and executable mode through relocation", () => {
  const f = fixture(), capture = () => prepareProcessBundle({ artifacts: f.artifacts, allowedRoots: [f.root], files: [{ path: "scripts/main.sh", source: f.source }] });
  const bundle = capture(); expect(capture().source.digest).toBe(bundle.source.digest);
  writeFileSync(f.source, "changed");
  const destination = join(f.root, "restored"); materializeProcessBundle(f.artifacts.verify(bundle.source), destination);
  expect(readFileSync(join(destination, "scripts/main.sh"), "utf8")).toBe("printf retained");
  expect(statSync(join(destination, "scripts/main.sh")).mode & 0o777).toBe(0o500);
});
it.each(["../escape", "/absolute", "a/../b", "a//b", "a\\b", ".env", ".env.local", ".git/config", "credentials/token"])("refuses unsafe or private mapped path %s", path => {
  const f = fixture(); expect(() => prepareProcessBundle({ artifacts: f.artifacts, allowedRoots: [f.root], files: [{ path, source: f.source }] })).toThrow();
});
it("refuses a symlink escape and permits an explicitly allowed external dependency root", () => {
  const f = fixture(), external = fixture(), link = join(f.root, "dependency"); symlinkSync(external.source, link);
  const capture = (allowedRoots: string[]) => prepareProcessBundle({ artifacts: f.artifacts, allowedRoots, files: [{ path: "node_modules/pkg/main.sh", source: link }] });
  expect(() => capture([f.root])).toThrow(/escaping/);
  expect(readProcessBundle(f.artifacts.verify(capture([f.root, external.root]).source)).files[0]?.path).toBe("node_modules/pkg/main.sh");
});
it("refuses duplicate names, file/directory collisions and changed inner digests", () => {
  const f = fixture();
  for (const paths of [["same", "same"], ["parent", "parent/child"]]) expect(() => prepareProcessBundle({ artifacts: f.artifacts, allowedRoots: [f.root], files: paths.map(path => ({ path, source: f.source })) })).toThrow();
  const bundle = prepareProcessBundle({ artifacts: f.artifacts, allowedRoots: [f.root], files: [{ path: "main.sh", source: f.source }] });
  const value = JSON.parse(f.artifacts.verify(bundle.source).toString()); value.files[0].data = Buffer.from("changed").toString("base64");
  expect(() => materializeProcessBundle(Buffer.from(JSON.stringify(value)), join(f.root, "bad"))).toThrow(/Invalid/);
});
