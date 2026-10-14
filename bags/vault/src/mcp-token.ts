import crypto from "node:crypto";

/** Use a dedicated MCP bearer or a domain-separated derivation, never the signing key; see docs/decisions/0016-vault-daemon-boundaries.md. */
export function resolveMcpToken(env: Readonly<Record<string, string | undefined>>, signingKey: string): string {
  if (env.VAULT_MCP_TOKEN) return env.VAULT_MCP_TOKEN;
  if (signingKey) return deriveMcpToken(signingKey);
  // No secret at all: an empty expected token matches nothing (see
  // timingSafeMatch in mcp.ts), so the endpoint stays closed.
  return "";
}

/** Domain-separated so the same JWT_SECRET can never yield this token by accident elsewhere. */
export function deriveMcpToken(jwtSecret: string): string {
  const key = crypto.hkdfSync("sha256", Buffer.from(jwtSecret, "utf8"), Buffer.alloc(0), Buffer.from("barry-vault/mcp-bearer/v1"), 32);
  return Buffer.from(key).toString("base64url");
}
