import { join, resolve } from "node:path";

export function vaultPaths(env: NodeJS.ProcessEnv = process.env, bag = resolve(import.meta.dirname, "..")): { data: string; database: string; socket: string } {
  const data = env.DATA_DIR ?? env.BARRY_BAG_DATA_DIR ?? "/usr/local/var/barry-vault";
  return {
    data,
    database: env.VAULT_DB_PATH ?? join(data, "vault.db"),
    socket: env.VAULT_SOCKET_PATH ?? env.BARRY_SERVICE_SOCKET ?? join(bag, "run", "vault.sock"),
  };
}
