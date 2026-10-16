import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { barryStoresDir } from "../services/home.mjs";
import { listStores } from "./store-inventory.js";

afterEach(() => { rmSync(barryStoresDir(), { recursive: true, force: true }); });

function createStore(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new DatabaseSync(path);
  try { db.exec("CREATE TABLE t(x)"); } finally { db.close(); }
}

it("lists node and identity stores without creating peers.db or failing on an unmapped identity folder", async () => {
  const root = barryStoresDir();
  createStore(join(root, "node", "schedules", "schedules.db"));
  createStore(join(root, "identities", "2b5e0f4a-0000-4000-8000-000000000000", "sessions", "sessions.db"));
  const stores = await listStores();
  expect(stores.map((store) => `${store.scope}:${store.bag}/${store.store}`).sort()).toEqual(["identity:sessions/sessions", "node:schedules/schedules"]);
  expect(stores.find((store) => store.scope === "identity")).toMatchObject({ partitionKey: "2b5e0f4a-0000-4000-8000-000000000000", identityName: undefined });
  expect(existsSync(join(root, "node", "nodes", "peers.db"))).toBe(false);
});
