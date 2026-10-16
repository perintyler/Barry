import { describe, expect, it } from "vitest";
import { Command } from "commander";
import { applyCommandTarget, assertOwnedSession, isIdentityCommand, isSystemCommand } from "./target.js";
function commands() {
  const root = new Command();
  for (const name of ["session", "service", "pack", "up", "fixture"])
    root.command(name);
  const identity = root.command("identity");
  for (const name of ["create", "list", "show", "delete"])
    identity.command(name);
  return root;
}
describe("CLI target", () => {
  it("root registers only system operations and identity directory management", () => {
    const root = commands();
    applyCommandTarget(root, { kind: "system" }, ["fixture"]);
    expect(root.commands.map((command) => command.name())).toEqual([
      "service",
      "up",
      "identity",
    ]);
    expect(
      root.commands.at(-1)!.commands.map((command) => command.name()),
    ).toEqual(["create", "list"]);
  });
  it("generated CLI registers identity operations and rejects foreign sessions", () => {
    const root = commands();
    applyCommandTarget(
      root,
      {
        kind: "identity",
        name: "bonanza",
        binding: { id: 42, home: "/fixture" },
      },
      ["fixture"],
    );
    expect(root.commands.map((command) => command.name())).toEqual([
      "session",
      "pack",
      "fixture",
      "identity",
    ]);
    expect(() => assertOwnedSession({ identity_id: 7 }, 42)).toThrow(
      "another identity",
    );
    expect(() => assertOwnedSession({ identity_id: 42 }, 42)).not.toThrow();
  });
});


describe("installation maintenance schedule visibility", () => {
  function surface() {
    const root = new Command();
    const schedule = root.command("schedule");
    for (const verb of ["list", "run", "pause", "resume", "history"]) schedule.command(verb, { isDefault: verb === "list" });
    return root;
  }
  it("exposes only read-only listing at root", () => {
    const root = surface();
    applyCommandTarget(root, { kind: "system" });
    expect(root.commands.map(command => command.name())).toEqual(["schedule"]);
    expect(root.commands[0].commands.map(command => command.name())).toEqual(["list"]);
    expect(isSystemCommand("schedule")).toBe(true);
    expect(isIdentityCommand("schedule")).toBe(false);
  });
  it("preserves identity operations and their ownership checks", () => {
    const root = surface();
    applyCommandTarget(root, { kind: "identity", name: "fixture", binding: { id: 2, home: null } });
    expect(root.commands[0].commands.map(command => command.name())).toEqual(["list", "run", "pause", "resume", "history"]);
  });
  it("rejects a root mutation instead of routing it to the default listing", async () => {
    const root = surface().exitOverride().configureOutput({ writeErr: () => {} });
    root.commands[0].exitOverride().configureOutput({ writeErr: () => {} });
    let listed = false;
    root.commands[0].commands[0].action(() => { listed = true; });
    applyCommandTarget(root, { kind: "system" });
    await expect(root.parseAsync(["schedule", "run", "tracker/retention"], { from: "user" })).rejects.toMatchObject({ code: "commander.unknownCommand" });
    expect(listed).toBe(false);
  });
});
