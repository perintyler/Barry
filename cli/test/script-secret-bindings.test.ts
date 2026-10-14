import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { upsertBag } from "../src/bags/registration.js";
import { getCurrentUser } from "../src/lib/current-user.js";
import { traits } from "@barry-rocks/identities-bag";
import { bindSecretReferences } from "@barry-rocks/sdk/internal/identities";
import { loadBuiltinRegistry } from "@barry-rocks/sdk/internal/bags";
import { provisionOwner, seedIdentityRow } from "./helpers/identities.js";

const execute = promisify(execFile);
it("hands a real bag script only its literal environment and selected identity secret", async () => {
  process.env.BARRY_CONFIG_ALLOW_EMPTY = "1";
  const home = process.env.BARRY_HOME!;
  const bag = join(home, "script-bag");
  mkdirSync(bag);
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "barry.yaml"), "secrets:\n  SCRIPT_KEY:\n    in: .env\n");
  writeFileSync(join(home, "config", "cli.yaml"), "bags: [script-fixture]\n");
  writeFileSync(join(home, "app-support", "env"), "SCRIPT_KEY=declared-script-key\nUNRELATED_KEY=hidden-file-key\n");
  writeFileSync(join(bag, ".env"), "SCRIPT_KEY=declared-script-key\nUNRELATED_KEY=hidden-file-key\n");
  writeFileSync(join(bag, "tools.ts"), 'throw new Error("script metadata must not import tools");');
  await traits.ensure([
    ...["bash", "filesystem", "sessions", "instructions"].map(name => ({ name, namespaces: [name], access: "read" as const, bag: name })),
    { name: "script-writer", namespaces: ["bash"], access: "readwrite", bag: "bash" },
  ], {});
  provisionOwner("Script fixture owner");
  const user = await getCurrentUser();
  // Rows with no directory: the generated CLI is bound to a row id and only reads it.
  const identity = seedIdentityRow({ actorId: user.id, name: "script-operator", metadata: {
    traits: ["script-writer"],
    secrets: bindSecretReferences({ SCRIPT_KEY: { in: ".env" } }, bag),
  } });
  writeFileSync(join(bag, "inspect.mjs"), 'console.log(JSON.stringify({ key:process.env.SCRIPT_KEY, literal:process.env.LITERAL, unrelated:process.env.UNRELATED_KEY }));');
  writeFileSync(join(bag, "bag.yaml"), `name: script-fixture\ndescription: Script fixture\nscripts:\n  inspect:\n    description: Inspect environment\n    entry: inspect.mjs\n    env: [LITERAL=explicit]\n    secrets: [SCRIPT_KEY]\n`);
  // A raw script runs under bash:Bash, which only a registered bag can declare:
  // a tool no registered bag declares is granted to no one.
  const { bash } = loadBuiltinRegistry();
  if (!bash) throw new Error("the bash bag ships with Barry");
  await upsertBag("bash", bash);
  await upsertBag("script-fixture", { type: "local", path: bag });
  const invoke = (id = identity.id) => execute(process.execPath, ["--import", "tsx", join(import.meta.dirname, "../src/identity.ts"), JSON.stringify({ home, id }), "script-fixture", "inspect"], {
    env: { ...process.env, SCRIPT_KEY: "ambient-key", UNRELATED_KEY: "ambient-unrelated" }, timeout: 30000,
  });
  const reader = seedIdentityRow({ actorId: user.id, name: "script-reader", metadata: { traits: [] } });
  await expect(invoke(reader.id)).rejects.toThrow("tool access denied");
  const result = await invoke();
  expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!)).toEqual({ key: "declared-script-key", literal: "explicit" });
  writeFileSync(join(bag, ".env"), "UNRELATED_KEY=hidden-file-key\n");
  await expect(invoke()).rejects.toThrow(/absent or empty/);
});
