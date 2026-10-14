import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// OAuth needs its token-cache home, browser/session settings and proxy/CA
// settings. Barry credentials and Node injection options are never inherited.
const ENVIRONMENT_KEYS = [
  "PATH", "HOME", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS",
  "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
];

export function oauthHelperLaunch(url: string, source: NodeJS.ProcessEnv = process.env): { command: string; args: string[]; env: Record<string, string> } {
  const env = Object.fromEntries(ENVIRONMENT_KEYS.flatMap(key => { const value = source[key]; return value === undefined ? [] : [[key, value]]; }));
  const proxy = env.HTTP_PROXY || env.HTTPS_PROXY || env.http_proxy || env.https_proxy;
  const helper = require.resolve("mcp-remote/dist/proxy.js");
  return { command: process.execPath, args: [helper, url, ...(proxy ? ["--enable-proxy"] : [])], env };
}
