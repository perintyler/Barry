import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, statSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseManifest } from "@barry-rocks/sdk/bags";
import { useTestInstance } from "@barry-rocks/sdk/services";
import { withStoreContext } from "@barry-rocks/sdk/internal/stores";
import { artifactCreate, artifactShare } from "../tools.js";
import { createLocalArtifactHttpHandler } from "./http.js";
import { listArtifacts, revokeArtifactShare, withArtifactStore } from "../index.js";

const directories: string[] = [];
const originalHome = process.env.BARRY_HOME;
afterEach(() => {
  process.env.BARRY_HOME = originalHome;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function setup() {
  directories.push(useTestInstance({ "artifacts.web": "http://127.0.0.1:4999" }));
  const root = mkdtempSync(join(tmpdir(), "artifact-http-"));
  directories.push(root);
  const stores = parseManifest(fileURLToPath(new URL("../../", import.meta.url)))!.stores!;
  const context = { root, identity: "tester", bags: { artifacts: { stores } } };
  return { root, context, handler: createLocalArtifactHttpHandler({ root }) };
}
describe("local artifact HTTP", () => {
  it("opens tool links, streams content and restricts the API to the owner", async () => {
    const { root, context, handler } = setup();
    const created = await withStoreContext(context, () =>
      artifactCreate.handler({ filename: "report.md", text: "# Hello" }, { secrets: {} }));
    expect(created.link).toBe(`http://127.0.0.1:4999/api/v1/identities/tester/artifacts/${created.artifact.id}`);
    const share = await withStoreContext(context, () =>
      artifactShare.handler({ action: "create", artifactId: created.artifact.id }, { secrets: {} }));
    expect(share.shareUrl).toBe(`http://127.0.0.1:4999/p/tester/${share.token}`);
    const request = (url: string, owner = false, init?: RequestInit) =>
      handler(new Request(url, init), { owner });
    const filepath = await withStoreContext(context, () => withArtifactStore(async store => store.binding.filepath));
    chmodSync(filepath, 0o644);
    const preview = await request(share.shareUrl!);
    expect(preview.status).toBe(200);
    const previewJson = await preview.json();
    expect(previewJson.artifact).toEqual({
      id: created.artifact.id, title: created.artifact.metadata.title, kind: created.artifact.content.kind,
      filename: created.artifact.content.filename, mimeType: created.artifact.content.mimeType,
      size: created.artifact.content.size, createdAt: created.artifact.content.createdAt,
    });
    expect(Object.keys(previewJson.artifact).sort()).toEqual(["createdAt", "filename", "id", "kind", "mimeType", "size", "title"]);
    expect(Object.keys(previewJson.share)).toEqual(["expiresAt"]);
    expect(statSync(filepath).mode & 0o777).toBe(0o644);
    const raw = await request(`${share.shareUrl}/raw`);
    expect(raw.status).toBe(200);
    expect(statSync(filepath).mode & 0o777).toBe(0o644);
    expect(raw.headers.get("Content-Type")).toBe("text/markdown");
    expect(raw.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await raw.text()).toBe("# Hello");
    expect((await request(created.link!)).status).toBe(401);
    expect((await (await request(created.link!, true)).json()).id).toBe(created.artifact.id);
    expect(await (await request(`${created.link}/content`, true)).text()).toBe("# Hello");
    expect((await (await request("http://local/api/v1/identities/tester/artifacts", true)).json()).items).toHaveLength(1);
    const patch = await request(`${created.link}/metadata`, true, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, title: "Updated" }),
    });
    expect(patch.status).toBe(200);
    expect((await patch.json()).metadata.title).toBe("Updated");
    expect((await request("http://local/health")).status).toBe(200);
    expect((await request("http://local/api/v1/identities/nobody/artifacts", true)).status).toBe(404);
    expect((await request("http://local/p/nobody/token")).status).toBe(404);
    expect((await request("http://local/p/%2F/token")).status).toBe(404);
    expect(readdirSync(join(root, "identities"))).toEqual(["tester"]);
    expect((await request("http://local/p/tester/wrong")).status).toBe(404);
    const expired = createLocalArtifactHttpHandler({ root, now: () => "2100-01-01T00:00:00.000Z" });
    expect((await expired(new Request(share.shareUrl!), { owner: false })).status).toBe(404);
    await withStoreContext(context, () => revokeArtifactShare(share.metadata!.id));
    expect((await request(share.shareUrl!)).status).toBe(404);
  });

  it("checks passwords and returns 503 during activation", async () => {
    const { context, handler } = setup();
    const created = await withStoreContext(context, () =>
      artifactCreate.handler({ filename: "report.md", text: "private" }, { secrets: {} }));
    const share = await withStoreContext(context, () =>
      artifactShare.handler({ action: "create", artifactId: created.artifact.id, password: "secret" }, { secrets: {} }));
    const request = (password?: string) => handler(new Request(share.shareUrl!, {
      headers: password ? { "X-Artifact-Password": password } : {},
    }), { owner: false });
    expect((await request()).status).toBe(401);
    expect((await handler(new Request(`${share.shareUrl}?password=secret`), { owner: false })).status).toBe(401);
    expect((await request("wrong")).status).toBe(403);
    expect((await request("secret")).status).toBe(200);
    const filepath = await withStoreContext(context, () => withArtifactStore(async store => store.binding.filepath));
    writeFileSync(`${filepath}.activation.json`, JSON.stringify({
      format: 1, id: randomUUID(), state: "prepared", filepath, identity: "tester",
      candidate: "candidate", previous: "previous", generation: "a".repeat(32), previousGeneration: "b".repeat(32),
    }));
    const unavailable = await request("secret");
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).error.code).toBe("unavailable");
    expect((await handler(new Request(created.link!), { owner: true })).status).toBe(503);
  });

  it("opens only the store the path names exactly", async () => {
    const { root, context, handler } = setup();
    const created = await withStoreContext(context, () =>
      artifactCreate.handler({ filename: "report.md", text: "# Hello" }, { secrets: {} }));
    const share = await withStoreContext(context, () =>
      artifactShare.handler({ action: "create", artifactId: created.artifact.id }, { secrets: {} }));
    const request = (url: string, owner = false) => handler(new Request(url), { owner });
    // On a case-insensitive disk TESTER would reach tester's store; a..b is a name stores refuse.
    for (const identity of ["TESTER", "a..b"]) {
      expect((await request(`http://local/p/${identity}/${share.token}`)).status).toBe(404);
      expect((await request(`http://local/api/v1/identities/${identity}/artifacts`, true)).status).toBe(404);
    }
    // A store file a crash left before its catalog was written must not be claimed by another spelling.
    const blank = join(root, "identities", "blank", "artifacts", "default.db");
    mkdirSync(dirname(blank), { recursive: true });
    writeFileSync(blank, "");
    expect((await request(`http://local/p/BLANK/${share.token}`)).status).toBe(404);
    expect((await request(`http://local/p/blank/${share.token}`)).status).toBe(404);
    expect(statSync(blank).size).toBe(0);
    await expect(withStoreContext({ ...context, identity: "blank" }, () => listArtifacts())).resolves.toMatchObject({ items: [] });
  });
});
