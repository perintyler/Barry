import { expect, it, vi } from "vitest";
import { ArtifactHttpClient } from "./client.js";

it("updates a share under its artifact, sending only the update body", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ id: "share-1" }), { status: 200 }));
  const client = new ArtifactHttpClient({ baseUrl: "https://artifacts.example", identityId: "identity-1", token: "synthetic", fetch });
  const input = { artifactId: "artifact-1", shareId: "share-1", expectedRevision: 1, revoked: true };
  await client.updateShare(input);
  expect(fetch).toHaveBeenCalledWith("https://artifacts.example/api/v1/identities/identity-1/artifacts/artifact-1/shares/share-1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ shareId: "share-1", expectedRevision: 1, revoked: true }) }));
});
