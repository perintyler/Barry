import { beforeEach, expect, it, vi } from "vitest";
import { getOAuthAccessToken, refreshOAuthToken } from "@barry-rocks/sdk/internal/vault";
import { noSseFetch } from "@barry-rocks/sdk/internal/mcp";
import { createOAuthFetch } from "./oauth-fetch.js";

vi.mock("@barry-rocks/sdk/internal/vault", () => ({
  getOAuthAccessToken: vi.fn(), refreshOAuthToken: vi.fn(),
}));
vi.mock("@barry-rocks/sdk/internal/mcp", () => ({ noSseFetch: vi.fn() }));
const server = "https://mcp.notion.com/mcp";
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(noSseFetch).mockResolvedValue(new Response("{}"));
});

it("uses the current token on a connection that survives token rotation", async () => {
  vi.mocked(getOAuthAccessToken).mockReturnValueOnce("first").mockReturnValueOnce("rotated");
  const fetch = createOAuthFetch(server);
  for (const token of ["first", "rotated"]) {
    await fetch(server, { method: "POST", body: "request", headers: { "Mcp-Session-Id": "session", Authorization: "Bearer stale" } });
    const init = vi.mocked(noSseFetch).mock.lastCall![1]!;
    expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${token}`);
    expect(new Headers(init.headers).get("Mcp-Session-Id")).toBe("session");
    expect(init.body).toBe("request");
  }
  expect(refreshOAuthToken).not.toHaveBeenCalled();
});

it("coalesces expiry refreshes before concurrent requests and keeps the connection usable", async () => {
  vi.mocked(getOAuthAccessToken).mockReturnValue(null);
  let finish!: (token: string) => void;
  vi.mocked(refreshOAuthToken).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const fetch = createOAuthFetch(server);
  const requests = [fetch(server), fetch(server)];
  expect(refreshOAuthToken).toHaveBeenCalledExactlyOnceWith(server);
  expect(noSseFetch).not.toHaveBeenCalled();
  finish("fresh");
  await Promise.all(requests);
  expect(noSseFetch).toHaveBeenCalledTimes(2);
  for (const [, init] of vi.mocked(noSseFetch).mock.calls) expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fresh");
  vi.mocked(getOAuthAccessToken).mockReturnValue("fresh");
  await fetch(server);
  expect(refreshOAuthToken).toHaveBeenCalledTimes(1);
});

it("reports expired auth without sending a request when refresh fails, and permits later recovery", async () => {
  vi.mocked(getOAuthAccessToken).mockReturnValue(null);
  vi.mocked(refreshOAuthToken).mockResolvedValueOnce(null).mockResolvedValueOnce("recovered");
  const fetch = createOAuthFetch(server);
  await expect(fetch(server)).rejects.toThrow("OAuth token expired");
  expect(noSseFetch).not.toHaveBeenCalled();
  await fetch(server);
  expect(noSseFetch).toHaveBeenCalledTimes(1);
});
