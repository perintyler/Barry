import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NodeRegistry } from "../../sdk/src/nodes/registry.js";
import { decodeJoinToken } from "../../sdk/src/nodes/join-token.js";
import { decodeJoinToken as decodeMasterJoinToken } from "../scripts/master-join-token.js";
import { registerWorkers } from "../src/commands/workers.js";

const state = vi.hoisted<{ registry: unknown }>(() => ({ registry: null }));
vi.mock("@barry-rocks/sdk/internal/nodes", async () => ({
  ...await import("../../sdk/src/nodes/join-token.js"),
  NodeRegistry: (await import("../../sdk/src/nodes/registry.js")).NodeRegistry,
  installationRegistry: () => state.registry,
}));

let root: string;
let registry: NodeRegistry;
let output: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "barry-invite-command-"));
  registry = new NodeRegistry(root, () => 1_700_000_000_000);
  state.registry = registry;
  output = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => { output.mockRestore(); registry.close(); rmSync(root, { recursive: true, force: true }); });

async function command(...args: string[]): Promise<string> {
  output.mockClear();
  const program = new Command();
  registerWorkers(program);
  await program.parseAsync(["workers", ...args], { from: "user" });
  const printed = output.mock.calls.flat().join("\n");
  return /barry workers join (barry_wj[12]\.\S+)/.exec(printed)?.[1] ?? "";
}

it("invites and rotates unscoped nonexpiring workers with master-compatible v1 tokens", async () => {
  const invite = decodeMasterJoinToken(await command("invite", "old-worker", "--url", "https://owner.example"));
  expect(registry.worker(invite.worker).inviteExpiresAt).toBeNull();
  const rotated = decodeMasterJoinToken(await command("rotate", "old-worker", "--url", "https://owner.example"));
  expect(rotated.worker).toBe(invite.worker);
  expect(rotated.credential).not.toBe(invite.credential);
});

it("uses v2 for explicit expiry and scoped invites, retaining the scoped 24-hour default", async () => {
  const expiring = decodeJoinToken(await command("invite", "expiring", "--url", "https://owner.example", "--expires-in", "60"));
  expect(expiring.v).toBe(2);
  expect(expiring.expiresAt).toBe(1_700_000_060_000);
  expect(expiring.jobs).toBeUndefined();
  const scoped = decodeJoinToken(await command("invite", "scoped", "--url", "https://owner.example", "--jobs", "bag:job@1"));
  expect(scoped.v).toBe(2);
  expect(scoped.jobs).toEqual(["bag:job@1"]);
  expect(scoped.expiresAt).toBe(1_700_086_400_000);
});

it("rejects malformed expiry before persisting any invitation", async () => {
  for (const expiry of ["0", "-1", "1.5", "NaN", "Infinity", "1e3", "9007199254740991"]) {
    await expect(command("invite", "bad", "--url", "https://owner.example", "--expires-in", expiry)).rejects.toThrow(/expires-in/);
  }
  expect(registry.workers()).toEqual([]);
});
