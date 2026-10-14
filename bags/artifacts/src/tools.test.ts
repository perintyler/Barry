import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serviceRegistryPath, writeServiceRegistry, ServiceRegistryError, useTestInstance } from "@barry-rocks/sdk/services";

import { withStoreContext } from "@barry-rocks/sdk/internal/stores";
import {
  artifactCreate,
  artifactRead,
  artifactList,
  artifactSearch,
  artifactUpdate,
  artifactShares,
  artifactShare,
} from "./tools.js";

const directories: string[] = [];
const originalHome = process.env.BARRY_HOME;
afterEach(() => {
  process.env.BARRY_HOME = originalHome;
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setupContext() {
  directories.push(useTestInstance({ "artifacts.web": "http://127.0.0.1:4999" }));
  const root = mkdtempSync(join(tmpdir(), "barry-artifact-tools-"));
  directories.push(root);
  const context = {
    node: "local",
    root,
    identity: "tester",
    bags: {
      artifacts: {
        stores: {
          default: {
            owned_by: "identity" as const,
            engine: "sqlite" as const,
            migrations: "./migrations/artifacts",
          },
        },
      },
    },
  };
  return { root, context };
}

describe("artifacts tools", () => {
  it("reads the registry for every link and refuses unwired shares before writing", async () => {
    const { context } = setupContext();
    await withStoreContext(context, async () => {
      const created = await artifactCreate.handler({ filename: "report.md", text: "hello" }, { secrets: {} });
      writeServiceRegistry({ version: 2, generated: new Date().toISOString(), resources: {
        "artifacts.web": { bag: "artifacts", name: "web", kind: "service", url: "http://127.0.0.1:5000" },
      } }, serviceRegistryPath());
      const read = await artifactRead.handler({ id: created.artifact.id }, { secrets: {} });
      expect(read.contentUrl).toBe(`http://127.0.0.1:5000/api/v1/identities/tester/artifacts/${created.artifact.id}/content`);
      directories.push(useTestInstance());
      const unwired = await artifactCreate.handler({ filename: "other.md", text: "hello" }, { secrets: {} });
      expect(unwired).not.toHaveProperty("link");
      expect(await artifactRead.handler({ id: unwired.artifact.id }, { secrets: {} })).not.toHaveProperty("contentUrl");
      await expect(artifactShare.handler({ action: "create", artifactId: created.artifact.id }, { secrets: {} })).rejects.toBeInstanceOf(ServiceRegistryError);
      expect((await artifactShares.handler({ artifactId: created.artifact.id }, { secrets: {} })).shares).toHaveLength(0);
    });
  });

  it("creates, reads, lists, searches, updates and shares artifacts through tools", async () => {
    const { context, root } = setupContext();

    await withStoreContext(context, async () => {
      // 1. Create artifact from text
      const created = await artifactCreate.handler(
        {
          filename: "test-report.md",
          text: "# Hello Artifact\nThis is a test artifact.",
          title: "Test Report",
          tags: ["test", "report"],
        },
        { secrets: {}, sessionId: "session-123" },
      );

      expect(created.artifact.id).toBeTruthy();
      expect(created.artifact.identityId).toBe("tester");
      expect(created.artifact.content.kind).toBe("markdown");
      expect(created.artifact.content.mimeType).toBe("text/markdown");
      expect(created.artifact.metadata.title).toBe("Test Report");
      expect(created.artifact.metadata.tags).toEqual(["test", "report"]);
      expect(created.link).toBe(`http://127.0.0.1:4999/api/v1/identities/tester/artifacts/${created.artifact.id}`);

      // 2. Read artifact
      const read = await artifactRead.handler(
        { id: created.artifact.id },
        { secrets: {} },
      );
      expect(read.artifact.id).toBe(created.artifact.id);
      expect(read.text).toBe("# Hello Artifact\nThis is a test artifact.");

      // 3. List artifacts
      const list = await artifactList.handler(
        { limit: 10 },
        { secrets: {} },
      );
      expect(list.artifacts).toHaveLength(1);
      expect(list.artifacts[0].id).toBe(created.artifact.id);

      // 4. Search artifacts
      const search = await artifactSearch.handler(
        { query: "Report" },
        { secrets: {} },
      );
      expect(search.artifacts).toHaveLength(1);
      expect(search.artifacts[0].id).toBe(created.artifact.id);

      // 5. Update artifact
      const updated = await artifactUpdate.handler(
        {
          id: created.artifact.id,
          expectedRevision: 1,
          title: "Updated Report",
          tags: ["test", "report", "v2"],
        },
        { secrets: {} },
      );
      expect(updated.metadata.title).toBe("Updated Report");
      expect(updated.metadata.revision).toBe(2);

      // 6. Share artifact (create)
      const shareCreated = await artifactShare.handler(
        {
          action: "create",
          artifactId: created.artifact.id,
          expiresInSeconds: 3600,
        },
        { secrets: {} },
      );
      expect(shareCreated.metadata).toBeTruthy();
      expect(shareCreated.token).toMatch(/^[a-f0-9]{64}$/);
      expect(shareCreated.shareUrl).toBe(`http://127.0.0.1:4999/p/tester/${shareCreated.token}`);

      // 7. List shares
      const sharesList = await artifactShares.handler(
        { artifactId: created.artifact.id },
        { secrets: {} },
      );
      expect(sharesList.shares).toHaveLength(1);
      expect(sharesList.shares[0].id).toBe(shareCreated.metadata.id);

      // 8. Update share
      const shareUpdated = await artifactShare.handler(
        {
          action: "update",
          shareId: shareCreated.metadata.id,
          expectedRevision: 1,
          expiresInSeconds: 7200,
        },
        { secrets: {} },
      );
      expect(shareUpdated.metadata.revision).toBe(2);

      // 9. Revoke share
      const revoked = await artifactShare.handler(
        {
          action: "revoke",
          shareId: shareCreated.metadata.id,
        },
        { secrets: {} },
      );
      expect(revoked.revoked).toBe(true);

      const afterRevoke = await artifactShares.handler(
        { artifactId: created.artifact.id },
        { secrets: {} },
      );
      expect(afterRevoke.shares[0].revoked).toBe(true);
    });
  });

  it("creates artifact from local file path", async () => {
    const { context, root } = setupContext();
    const filePath = join(root, "input-file.json");
    writeFileSync(filePath, JSON.stringify({ key: "value" }, null, 2));

    await withStoreContext(context, async () => {
      const created = await artifactCreate.handler(
        {
          filename: "input-file.json",
          path: filePath,
        },
        { secrets: {} },
      );

      expect(created.artifact.content.kind).toBe("code");
      expect(created.artifact.content.mimeType).toBe("application/json");

      const read = await artifactRead.handler(
        { id: created.artifact.id },
        { secrets: {} },
      );
      expect(read.text).toBe(JSON.stringify({ key: "value" }, null, 2));
    });
  });
});
