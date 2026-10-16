import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { ownerCommand, registerOwner, type OwnerCommandDeps } from "./owner.js";
import { applyCommandTarget } from "../target.js";

function fixture() {
  const store = { current: vi.fn(() => null as { actorId: number; name: string; boundAt: number } | null), bind: vi.fn((selection: { actorId: number; actorToken: string }) => ({ actorId: selection.actorId, name: "Tyler", boundAt: 1000 })) };
  const deps: OwnerCommandDeps = { owner: vi.fn(async () => store), users: vi.fn(async () => [{ id: 7, token: "private-user-key", name: "Tyler" }]), interactive: true, confirm: vi.fn(async () => true), write: vi.fn() };
  return { deps, store };
}
describe("installation owner CLI", () => {
  it("shows user candidates and safe JSON without exposing durable tokens", async () => {
    const { deps, store } = fixture();
    await ownerCommand(deps, undefined, { json: true });
    expect(JSON.parse(vi.mocked(deps.write).mock.calls[0][0])).toEqual({ owner: null, users: [{ id: 7, name: "Tyler" }] });
    expect(store.bind).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(deps.write).mock.calls)).not.toContain("private-user-key");
  });
  it("confirms the selected user and preserves its durable key across the review", async () => {
    const { deps, store } = fixture();
    await ownerCommand(deps, "7");
    expect(deps.confirm).toHaveBeenCalledWith('Bind installation ownership to 7 "Tyler"?');
    expect(store.bind).toHaveBeenCalledWith({ actorId: 7, actorToken: "private-user-key" });
    expect(deps.write).toHaveBeenCalledWith('Installation owner: 7 "Tyler"');
  });
  it("does not bind after a declined confirmation", async () => {
    const { deps, store } = fixture();
    vi.mocked(deps.confirm).mockResolvedValue(false);
    await ownerCommand(deps, "7");
    expect(store.bind).not.toHaveBeenCalled();
  });
  it("requires an explicit unattended choice and rejects malformed IDs before reading storage", async () => {
    const { deps, store } = fixture();
    deps.interactive = false;
    await expect(ownerCommand(deps, "7")).rejects.toThrow("--yes");
    for (const id of ["0", "-1", "7junk", "07", "9007199254740992"]) await expect(ownerCommand(deps, id, { yes: true })).rejects.toThrow("positive");
    expect(deps.owner).not.toHaveBeenCalled();
    await ownerCommand(deps, "7", { yes: true });
    expect(store.bind).toHaveBeenCalledOnce();
  });
  it("refuses unknown users, replacing another owner and failed durable bindings", async () => {
    const { deps, store } = fixture();
    await expect(ownerCommand(deps, "8", { yes: true })).rejects.toThrow("unavailable");
    store.current.mockReturnValue({ actorId: 8, name: "Another", boundAt: 1000 });
    await expect(ownerCommand(deps, "7", { yes: true })).rejects.toThrow("already bound");
    store.current.mockReturnValue(null);
    store.bind.mockImplementation(() => { throw new Error("changed"); });
    await expect(ownerCommand(deps, "7", { yes: true })).rejects.toThrow("changed");
    expect(deps.write).not.toHaveBeenCalled();
  });
  it("makes owner selection available only at system target", () => {
    const identity = new Command(); registerOwner(identity, fixture().deps);
    applyCommandTarget(identity, { kind: "identity", name: "fixture", binding: { id: 1, home: null } });
    expect(identity.commands.map(command => command.name())).not.toContain("owner");
    const system = new Command(); registerOwner(system, fixture().deps);
    applyCommandTarget(system, { kind: "system" });
    expect(system.commands.map(command => command.name())).toContain("owner");
  });
});
