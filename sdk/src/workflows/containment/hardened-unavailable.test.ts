import { expect, it, vi } from "vitest";
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: (path: import("node:fs").PathLike) => String(path) === "/sys/fs/cgroup/cgroup.controllers" ? false : actual.existsSync(path) };
});
import { ProcessExecutor } from "../executor.js";
it("refuses hardened executor startup when cgroups v2 is unavailable", () => {
  expect(() => new ProcessExecutor({ profile: "hardened" })).toThrow(/requires Linux cgroups v2|requires cgroups v2/);
});
