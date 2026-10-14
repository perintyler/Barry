/**
 * Shared MCP transport utilities.
 *
 * Workarounds for bugs in the MCP SDK + Node undici that affect all
 * bag proxy connections (both in @barry-rocks/sdk/bags and in engine).
 */

/**
 * Custom fetch that bags the GET SSE stream opened by
 * StreamableHTTPClientTransport after `notifications/initialized`.
 *
 * The SDK opens a long-lived GET SSE connection for server-push notifications.
 * When the remote server (e.g. Sentry via Cloudflare) speaks HTTP/2, this
 * long-lived stream triggers a Node undici bug: subsequent POST requests on the
 * same H2 connection hang indefinitely. Bag proxies only need
 * request-response, so returning 405 tells the SDK "not supported" and it
 * skips the stream entirely.
 */
export function noSseFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  if (init?.method === "GET") {
    return Promise.resolve(new Response(null, { status: 405 }));
  }
  return fetch(url, init);
}
