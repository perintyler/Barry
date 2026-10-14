import { owner } from "@barry-rocks/identities-bag";
import { afterEach, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { renameIdentityRow, seedIdentityRow } from "../test/helpers/identities.js";
import { Sessions } from "@barry-rocks/sessions-bag/client";
import { openInstance } from "@barry-rocks/sdk/internal/services";
import { barryAppSupportDir } from "@barry-rocks/sdk/services";

it("executes the generated entry with a stable owner after rename and rejects foreign sessions and instances", async () => {
  const user = await owner.users.create({
    name: "fixture",
    email: "binding@example.test",
  });
  owner.installation().bind({ actorId: user.id, actorToken: user.token });
  // Rows with no directory: the generated CLI binds to a row id and only reads it.
  const identity = seedIdentityRow({ actorId: user.id, name: "bonanza" });
  const foreign = seedIdentityRow({ actorId: user.id, name: "foreign" });
  const sessionId = "binding-foreign-session";
  await Sessions.create({
    id: sessionId,
    agent_token: null,
    metadata: {},
    identity_id: foreign.id,
  });
  const binding = {
    id: identity.id,
    home: process.env.BARRY_HOME,
    instance: openInstance(barryAppSupportDir()).id,
  };
  renameIdentityRow(identity.id, "renamed");
  const invoke = (value: typeof binding, args: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(import.meta.dirname, "identity.ts"),
        JSON.stringify(value),
        ...args,
      ],
      {
        env: {
          ...process.env,
          NO_COLOR: "1",
          BARRY_CONFIG_ALLOW_EMPTY: "1",
        },
        encoding: "utf8",
        timeout: 40000,
      },
    );
  const help = invoke(binding, ["--help"]);
  expect(help.status, help.stderr).toBe(0);
  expect(help.stdout).toContain("renamed");
  expect(help.stdout).not.toMatch(/^\s+service\s/m);
  const resume = invoke(binding, ["session", "resume", sessionId]);
  expect(resume.status).not.toBe(0);
  expect(resume.stderr).toContain("belongs to another identity");
  const wrongInstance = invoke({ ...binding, instance: "another-instance" }, [
    "--help",
  ]);
  expect(wrongInstance.status).not.toBe(0);
  expect(wrongInstance.stderr).toContain("another instance");
}, 60000);

afterEach(() => vi.unstubAllEnvs());
