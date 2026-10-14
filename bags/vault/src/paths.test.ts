import { expect, it } from "vitest";
import { vaultPaths } from "./paths.js";
it("resolves data, database and socket with explicit overrides before service values and defaults", () => {
  expect(vaultPaths({}, "/bag")).toEqual({ data: "/usr/local/var/barry-vault", database: "/usr/local/var/barry-vault/vault.db", socket: "/bag/run/vault.sock" });
  expect(vaultPaths({ BARRY_BAG_DATA_DIR: "/state", BARRY_SERVICE_SOCKET: "/state/run/socket" }, "/bag")).toEqual({ data: "/state", database: "/state/vault.db", socket: "/state/run/socket" });
  expect(vaultPaths({ DATA_DIR: "/data", BARRY_BAG_DATA_DIR: "/state", VAULT_DB_PATH: "/db", VAULT_SOCKET_PATH: "/socket", BARRY_SERVICE_SOCKET: "/state/run/socket" }, "/bag")).toEqual({ data: "/data", database: "/db", socket: "/socket" });
  expect(vaultPaths({ DATA_DIR: "/data", BARRY_BAG_DATA_DIR: "/state" }).database).toBe("/data/vault.db");
});
