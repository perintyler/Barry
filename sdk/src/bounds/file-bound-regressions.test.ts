import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyBoundGuards } from "./tool-guards.js";
import { BoundSchema, type Bound } from "./types.js";
import type { ToolContext } from "../tools/define-tool.js";

describe("original review file-bound regressions", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "barry-file-bounds-"));
    mkdirSync(join(root, ".ssh"));
    mkdirSync(join(root, "allowed"));
    writeFileSync(join(root, ".ssh", "key"), "synthetic fixture");
    writeFileSync(join(root, "allowed", "file"), "public fixture");
    symlinkSync(join(root, ".ssh"), join(root, "alias"));
    vi.stubEnv("HOME", root);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });
  async function invoke(name: string, params: Record<string, unknown>, bound: Bound) {
    const handler = vi.fn(async (_params: Record<string, unknown>, _context: ToolContext) => "called");
    const [tool] = applyBoundGuards([{ name, handler }], bound);
    return tool.handler(params, { secrets: {} });
  }
  it("refuses Bash cat of a denied path", async () => {
    await expect(invoke("Bash", { command: "cat ~/.ssh/key" }, { files: { deny: ["~/.ssh/**"] } })).rejects.toThrow("Access denied");
  });
  it("refuses a recursive search rooted above a denied directory", async () => {
    await expect(invoke("Grep", { path: root, pattern: "synthetic" }, { files: { deny: ["~/.ssh/**"] } })).rejects.toThrow("Access denied");
  });
  it("guards filesystem open", async () => {
    await expect(invoke("open", { path: join(root, ".ssh/key") }, { files: { deny: ["~/.ssh/**"] } })).rejects.toThrow("Access denied");
  });
  it("matches the denied directory itself", async () => {
    await expect(invoke("LS", { path: join(root, ".ssh") }, { files: { deny: ["~/.ssh/**"] } })).rejects.toThrow("Access denied");
  });
  it("resolves an existing symlink before checking policy", async () => {
    await expect(invoke("Read", { file_path: join(root, "alias/key") }, { files: { deny: ["~/.ssh/**"] } })).rejects.toThrow("Access denied");
  });
  it.runIf(process.platform === "darwin")("matches default macOS filesystem case semantics", async () => {
    await expect(invoke("Read", { file_path: join(root, ".SSH/key") }, { files: { deny: ["~/.ssh/**"] } })).rejects.toThrow("Access denied");
  });
  it("checks the normalized allow candidate without rejecting its tilde spelling", async () => {
    await expect(invoke("Read", { file_path: "~/allowed/file" }, { files: { allow: [join(root, "allowed/**")] } })).resolves.toBe("called");
  });
  it("anchors a relative allowed root at cwd", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(root);
    await expect(invoke("Read", { file_path: "/usr/local/allowed/foreign" }, { files: { allow: ["allowed/**"] } })).rejects.toThrow("Access denied");
  });
  it("checks a default search root and unanchored denied subtree", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(root);
    await expect(invoke("Grep", { pattern: "synthetic" }, { files: { deny: [".ssh/**"] } })).rejects.toThrow("Access denied");
  });
  it("checks a bare secret filename in ordinary shell reads", async () => {
    await expect(invoke("Bash", { command: "cat .env" }, { files: { deny: ["*.env"] } })).rejects.toThrow("Access denied");
  });
  it("refuses ambiguous relative allow roots at schema validation", () => {
    expect(BoundSchema.safeParse({ files: { allow: ["src/**"] } }).success).toBe(false);
    expect(BoundSchema.safeParse({ files: { allow: [join(root, "allowed/**")] } }).success).toBe(true);
  });
  it.each(["printf x > ~/.ssh/key", "cat < ~/.ssh/key", "bash -c 'printf x >> ~/.ssh/key'"])("guards file redirection %s", async command => {
    await expect(invoke("Bash", { command }, { files: { deny: ["~/.ssh/**"] } })).rejects.toThrow("Access denied");
  });
  it("withholds Bash for public paths too instead of claiming cwd or script containment", async () => {
    await expect(invoke("Bash", { command: "cat ~/allowed/file" }, { files: { deny: ["~/.ssh/**"] } })).rejects.toThrow("Bash is withheld");
  });
  it("allows ordinary Bash without file restrictions", async () => {
    await expect(invoke("Bash", { command: "printf hello" }, {})).resolves.toBe("called");
  });
  it("refuses recursive searches below an absolute wildcard root", async () => {
    await expect(invoke("Grep", { path: join(root, "allowed"), pattern: "fixture" }, { files: { deny: [join(root, "*.pem")] } })).rejects.toThrow("Access denied");
  });
  it("allows an ordinary public file", async () => {
    await expect(invoke("Read", { file_path: join(root, "allowed/file") }, { files: { deny: ["~/.ssh/**"] } })).resolves.toBe("called");
  });
});
