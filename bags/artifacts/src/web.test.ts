import { afterEach, expect, it, vi } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import type { Server } from "node:http";
import { parseManifest } from "@barry-rocks/sdk/bags";
import { resolveLaunch } from "@barry-rocks/sdk/internal/services";
import { serviceRegistryPath, writeServiceRegistry, useTestInstance } from "@barry-rocks/sdk/services";

import { withStoreContext } from "@barry-rocks/sdk/internal/stores";
import { artifactCreate, artifactShare } from "./tools.js";

const directories: string[] = [];
const originalHome = process.env.BARRY_HOME;
let server: Server | undefined;
afterEach(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  vi.unstubAllEnvs();
  process.env.BARRY_HOME = originalHome;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
it("declares a source HTTP service that launch resolves", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const web = parseManifest(root)!.services.web;
  expect(web).toMatchObject({ entry: "src/web.ts", serves: "http", health: "/health", secrets: ["BARRY_SECRET"] });
  expect(resolveLaunch(web, root).args).toContain(join(root, "src/web.ts"));
  expect(existsSync(join(root, "src/web.ts"))).toBe(true);
});
it("serves shares, HEAD, sign-in and bearer PATCH over HTTP", async () => {
  vi.stubEnv("BARRY_SECRET", "test-secret");
  const home = useTestInstance();
  directories.push(home);
  const root = join(home, "app-support", "stores");
  const stores = parseManifest(fileURLToPath(new URL("../", import.meta.url)))!.stores!;
  const context = { root, identity: "tester", bags: { artifacts: { stores } } };
  server = (await import("./web.js")).server;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP port");
  const base = `http://127.0.0.1:${address.port}`;
  writeServiceRegistry({ version: 2, generated: new Date().toISOString(), resources: {
    "artifacts.web": { bag: "artifacts", name: "web", kind: "service", url: base },
  } }, serviceRegistryPath());
  const created = await withStoreContext(context, () =>
    artifactCreate.handler({ filename: "report.md", text: "# Streamed" }, { secrets: {} }));
  const share = await withStoreContext(context, () =>
    artifactShare.handler({ action: "create", artifactId: created.artifact.id }, { secrets: {} }));
  const unsigned = await fetch(`${base}/`, { redirect: "manual" });
  expect(unsigned.status).toBe(303);
  expect(unsigned.headers.get("Location")).toBe("/sign-in");
  const signedIn = await fetch(`${base}/sign-in`, {
    method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ secret: "test-secret" }),
  });
  expect(signedIn.status).toBe(303);
  const cookie = signedIn.headers.get("Set-Cookie")!.split(";")[0];
  for (const headers of [{ Cookie: cookie }, { Authorization: "Bearer test-secret" }]) {
    const landing = await fetch(`${base}/`, { headers });
    expect(landing.status).toBe(200);
    expect(landing.headers.get("Content-Type")).toContain("text/html");
    expect(landing.headers.get("Cache-Control")).toBe("no-store");
    const html = await landing.text();
    expect(html).toContain("signed in to Barry's artifacts");
    expect(html).toContain("/p/…");
    expect(html).toContain("/api/v1/identities/&lt;identity&gt;/artifacts");
  }
  const landingHead = await fetch(`${base}/`, { method: "HEAD", headers: { Cookie: cookie } });
  expect(landingHead.status).toBe(200); expect(await landingHead.text()).toBe("");
  const preview = await fetch(share.shareUrl!);
  expect(preview.status).toBe(200);
  expect((await preview.json()).artifact.id).toBe(created.artifact.id);
  expect(await (await fetch(`${share.shareUrl}/raw`)).text()).toBe("# Streamed");
  const head = await fetch(`${share.shareUrl}/raw`, { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  expect(await (await fetch(`${base}/sign-in`)).text()).toContain("<form");
  expect((await fetch(created.link!)).status).toBe(401);
  const patch = await fetch(`${created.link}/metadata`, {
    method: "PATCH", headers: { Authorization: "Bearer test-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision: 1, title: "HTTP title" }),
  });
  expect(patch.status).toBe(200);
  expect((await patch.json()).metadata.title).toBe("HTTP title");
});
