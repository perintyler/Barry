import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBagResourceServer, createBagServer } from "../bag-server.js";
import { parseManifest, parseManifestObjectSafe } from "../../bags/manifest.js";

// Events provides a tracked manifest that survives the strict remote wire schema.
const FIXTURE_BAG_DIR = new URL("../../../../bags/events", import.meta.url).pathname;

async function readManifestOverMcp(bagDir: string): Promise<Record<string, unknown>> {
  const server = await createBagResourceServer({ bagDir });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "bag-server-test", version: "1.0.0" });
  await client.connect(clientTransport);
  try {
    const { contents } = await client.readResource({ uri: "barry://manifest" });
    return JSON.parse((contents[0] as { text: string }).text) as Record<string, unknown>;
  } finally {
    await client.close();
  }
}

/**
 * The wire contract for third-party bags is "your bag.yaml as JSON".
 * This locks it: what the server emits must validate against the same strict
 * schema used for manifests on disk.
 */
describe("createBagServer barry://manifest", () => {
  it("keeps createBagServer as a deprecated alias of createBagResourceServer (SDK-22)", () => {
    // Any external importer of the old name must keep working after the rename.
    expect(createBagServer).toBe(createBagResourceServer);
  });

  it("round-trips a real bag manifest through the strict schema", async () => {
    const wire = await readManifestOverMcp(FIXTURE_BAG_DIR);

    const parsed = parseManifestObjectSafe(wire, "wire", { source: "remote" });
    expect(parsed.error).toBeNull();
    expect(parsed.manifest).not.toBeNull();

    const onDisk = parseManifest(FIXTURE_BAG_DIR);
    expect(parsed.manifest?.name).toBe(onDisk?.name);
    expect(parsed.manifest?.description).toBe(onDisk?.description);
    expect(parsed.manifest?.instructions ?? null).toBe(onDisk?.instructions ?? null);
    expect(Object.keys(parsed.manifest?.traits ?? {})).toEqual(Object.keys(onDisk?.traits ?? {}));
  });

  // These name files on the serving machine; honoring them remotely would be
  // both meaningless and an attack surface.
  it("strips local-only entry fields", async () => {
    const wire = await readManifestOverMcp(FIXTURE_BAG_DIR);
    expect((wire.tools as Record<string, unknown> | undefined)?.entry).toBeUndefined();
    expect(wire.server).toBeUndefined();
  });
});

/**
 * The MCP proxy reads barry://tools-meta to learn each proxied tool's namespace
 * and access level. It was consumed but never produced, so proxied tools fell
 * back to access "write" and read-only traits could not match them.
 */
describe("createBagServer barry://tools-meta", () => {
  it("serves per-tool namespace and access metadata", async () => {
    const bagDir = mkdtempSync(join(tmpdir(), "bag-meta-"));
    try {
      writeFileSync(
        join(bagDir, "bag.yaml"),
        [
          "version: v0.1",
          "name: meta-bag",
          "description: exposes tool metadata",
          "",
        ].join("\n"),
        "utf-8",
      );

      writeFileSync(join(bagDir, "tools.ts"), `
export const read = { name: "meta_read", namespace: "meta", access: "read", description: "Read", schema: {}, handler: async () => "ok" };
export const write = { name: "meta_write", namespace: "meta", access: "write", description: "Write", schema: {}, handler: async () => "ok" };
`);
      const server = await createBagResourceServer({ bagDir });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "meta-test", version: "1.0.0" });
      await client.connect(clientTransport);

      try {
        const { contents } = await client.readResource({ uri: "barry://tools-meta" });
        const meta = JSON.parse((contents[0] as { text: string }).text) as Array<{
          name: string;
          namespace: string;
          access: string;
        }>;

        expect(meta).toHaveLength(2);
        expect(meta.find((m) => m.name === "meta_read")?.access).toBe("read");
        expect(meta.find((m) => m.name === "meta_write")?.namespace).toBe("meta");
      } finally {
        await client.close();
      }
    } finally {
      rmSync(bagDir, { recursive: true, force: true });
    }
  });
});
