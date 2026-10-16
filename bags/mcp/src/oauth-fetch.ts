import { getOAuthAccessToken, refreshOAuthToken } from "@barry-rocks/sdk/internal/vault";
import { noSseFetch } from "@barry-rocks/sdk/internal/mcp";

/** Resolve OAuth on each request: a pooled MCP connection can outlive its token. */
export function createOAuthFetch(serverUrl: string): typeof noSseFetch {
  let refreshing: Promise<string | null> | undefined;
  return async (url, init) => {
    let token = getOAuthAccessToken(serverUrl);
    if (!token) {
      refreshing ??= refreshOAuthToken(serverUrl).finally(() => { refreshing = undefined; });
      token = await refreshing;
    }
    if (!token) throw new Error("OAuth token expired; reauthorize this MCP bag.");
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return noSseFetch(url, { ...init, headers });
  };
}
