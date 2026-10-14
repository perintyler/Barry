import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeRegistry } from "@barry-rocks/sdk/internal/nodes";
import { readNodeStore } from "./store.js";

describe("node-owned peers store", () => {
  it("retains its installation and invited workers across fresh handles without exposing credentials", () => {
    const root = mkdtempSync(join(tmpdir(), "barry-node-bag-"));
    let registry = new NodeRegistry(root);
    try {
      const installation = registry.id;
      const { worker, credential } = registry.inviteWorker("test-worker");
      const ownerCredential = `${credential}-owner`;
      const owner = registry.join({ id: "remote-installation", name: "test-owner", url: "https://owner.example", workerId: "remote-worker", jobs: ["fixture:job@1"] }, ownerCredential);
      registry.close(); registry = new NodeRegistry(root);
      const result = readNodeStore(registry);
      expect(result.installation).toBe(installation);
      expect(result.workers).toEqual([worker]);
      expect(result.owners).toEqual([{ id: owner.id, name: owner.name, url: owner.url, workerId: owner.workerId, joinedAt: owner.joinedAt }]);
      expect(registry.ownerCredential(owner.id)).toBe(ownerCredential);
      expect(JSON.stringify(result)).not.toContain(credential);
      expect(JSON.stringify(result)).not.toContain(ownerCredential);
    } finally { registry.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
