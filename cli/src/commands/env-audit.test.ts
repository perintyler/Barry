/**
 * `barry env audit`: the instance env against what core and bags declare.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { auditEnv, envDeclarations, type EnvDeclaringBag } from "./env.js";

/** A bag with one service declaring the given env. */
function bag(secrets: string[]): EnvDeclaringBag {
  return { name: "app", services: [{ name: "web", secrets }], schedules: [], actionsDirs: [] };
}

describe("env audit", () => {
  const declarations = envDeclarations([
    bag(["APP_TOKEN", "APP_SIGNING_KEY"]),
  ]);

  it("counts a key declared by core or a bag, by the key it reads", () => {
    const audit = auditEnv(["BARRY_SECRET", "APP_TOKEN", "APP_SIGNING_KEY"], declarations, ["BARRY_SECRET", "APP_TOKEN", "APP_SIGNING_KEY"]);
    expect(audit.undeclared).toEqual([]);
    expect(audit.missing).toEqual([]);
    expect(audit.declared.map((d) => d.key)).toEqual(["APP_SIGNING_KEY", "APP_TOKEN", "BARRY_SECRET"]);
    expect(audit.declared.find((d) => d.key === "APP_TOKEN")?.by).toEqual(["app.web"]);
  });

  it("names a key nothing declares, however much source mentions it", () => {
    expect(auditEnv(["BARRY_SECRET", "APP_TOKEN", "RETIRED_PORT"], declarations, ["BARRY_SECRET", "APP_TOKEN", "APP_SIGNING_KEY"]).undeclared).toEqual(["RETIRED_PORT"]);
  });

  it("checks the selected binding even when an unrelated same-name file value exists", () => {
    expect(auditEnv(["BARRY_SECRET", "APP_TOKEN"], declarations, ["BARRY_SECRET", "APP_SIGNING_KEY"]).missing)
      .toEqual([{ key: "APP_TOKEN", by: ["app.web"] }]);
  });

  it("accepts credentials resolved from Keychain or vault without a private-file entry", () => {
    expect(auditEnv([], declarations, ["BARRY_SECRET", "APP_TOKEN", "APP_SIGNING_KEY"]).missing).toEqual([]);
  });

  it("discovers action credential names without treating literals or identity credentials as required instance-file entries", () => {
    const directory = mkdtempSync(join(tmpdir(), "action-secret-audit-"));
    try {
      mkdirSync(join(directory, "task"));
      writeFileSync(join(directory, "task", "action.yaml"), "name: task\ndescription: Run task\nrun: task.ts\nsecrets: [ACTION_API_KEY]\nenv: [MODE=fast]\n");
      const declarations = envDeclarations([{ ...bag([]), actionsDirs: [directory] }]);
      const present = auditEnv(["BARRY_SECRET", "ACTION_API_KEY", "MODE"], declarations, ["BARRY_SECRET", "APP_TOKEN", "APP_SIGNING_KEY"]);
      expect(present.declared.find(item => item.key === "ACTION_API_KEY")?.by).toEqual(["app action task"]);
      expect(present.undeclared).toEqual(["MODE"]);
      expect(auditEnv(["BARRY_SECRET"], declarations, ["BARRY_SECRET", "APP_TOKEN", "APP_SIGNING_KEY"]).missing).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("counts a key a bag script reads by name, and not a literal it sets", () => {
    const scripted: EnvDeclaringBag = {
      name: "ops",
      services: [],
      schedules: [],
      actionsDirs: [],
      manifest: { scripts: { release: { secrets: ["PUBLIC_REPO"], env: ["MODE=fast"] } } },
    };
    const audit = auditEnv(["BARRY_SECRET", "PUBLIC_REPO", "MODE"], envDeclarations([scripted]));
    expect(audit.declared.find((d) => d.key === "PUBLIC_REPO")?.by).toEqual(["ops script release"]);
    expect(audit.undeclared).toEqual(["MODE"]);
  });
});
