import { installationRegistry, type NodeRegistry } from "@barry-rocks/sdk/internal/nodes";

/** Read the node-owned peers store without exposing owner credentials. */
export function readNodeStore(registry: NodeRegistry = installationRegistry()) {
  return {
    installation: registry.id,
    workers: registry.workers(),
    owners: registry.owners().map(({ id, name, url, workerId, joinedAt }) => ({ id, name, url, workerId, joinedAt })),
  };
}
