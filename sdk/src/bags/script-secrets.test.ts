import { expect, it } from "vitest";
import { parseManifestObjectSafe } from "./manifest.js";

it("retains script secret declarations and rejects bare credential names in env", () => {
  const manifest = (script: unknown) => parseManifestObjectSafe({ name: "script-demo", description: "demo", scripts: { deploy: script } });
  const script = { description: "Deploy", command: "node", secrets: ["API_KEY"], env: ["REGION=local"] };
  expect(manifest(script).manifest?.scripts.deploy).toMatchObject({ secrets: ["API_KEY"], env: ["REGION=local"] });
  expect(manifest({ ...script, env: ["API_KEY"] }).error).toContain("use secrets for credential names");
});
