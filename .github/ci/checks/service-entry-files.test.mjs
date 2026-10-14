import { test } from "node:test";
import assert from "node:assert/strict";
import { serviceEntryFiles } from "./service-entry-files.mjs";
test("entry paths use the bag root even when the working directory is different", () => {
  assert.deepEqual(serviceEntryFiles("bags/sessions/bag.yaml", { api: { entry: "api/src/index.ts", "working-directory": "api" } }), ["bags/sessions/api/src/index.ts"]);
});
test("explicit interpreter arguments retain working-directory path resolution", () => {
  assert.deepEqual(serviceEntryFiles("bags/demo/bag.yaml", { api: { command: "node", args: ["--import", "tsx", "src/index.ts"], "working-directory": "server" } }), ["bags/demo/server/src/index.ts"]);
});
