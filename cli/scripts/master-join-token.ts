// Frozen from origin/master (285639e70aeae81e34cf29786cf6e88c0bd360dc).
// Keep the strict decoder independent of the current SDK and in the shipped verifier tree.
import { z } from "zod";

/**
 * What `barry workers invite` hands to the machine that will join.
 *
 * The token is a credential: whoever holds it can claim work as this worker.
 * Two machines joining with one token share the worker id, and the owner
 * treats the second as a restart of the first (WorkerRestarted).
 */
export interface JoinToken {
  v: 1;
  /** The owner's installation id; the worker refuses an owner that answers with another. */
  owner: string;
  /** Display name the owner gave this worker. */
  name: string;
  /** The worker id the owner assigned; claims are attributed to it. */
  worker: string;
  /** The owner's workflows address, https only. */
  url: string;
  credential: string;
}

export const JOIN_TOKEN_PREFIX = "barry_wj1.";
/** Every worker credential starts with this, so an owner can refuse it on every route but /api/worker. */
export const WORKER_CREDENTIAL_PREFIX = "barry_wk_";
const identifier = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i).refine(value => !value.includes(".."), "invalid identifier");
const tokenSchema = z.strictObject({
  v: z.literal(1),
  owner: identifier,
  name: identifier,
  worker: identifier,
  url: z.string().max(2048),
  credential: z.string().startsWith(WORKER_CREDENTIAL_PREFIX).min(40).max(200),
});

/** An owner address a worker may call: https, no credentials, no query or fragment. */
export function ownerUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`invalid owner address ${value}`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("a workflow owner address must be https:// with no embedded credentials, query or fragment");
  }
  return url.href.replace(/\/$/, "");
}

export function encodeJoinToken(token: JoinToken): string {
  const value = tokenSchema.parse({ ...token, url: ownerUrl(token.url) });
  return `${JOIN_TOKEN_PREFIX}${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
}

export function decodeJoinToken(text: string): JoinToken {
  const trimmed = text.trim();
  if (!trimmed.startsWith(JOIN_TOKEN_PREFIX)) throw new Error(`not a join token: it should start with ${JOIN_TOKEN_PREFIX}`);
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(trimmed.slice(JOIN_TOKEN_PREFIX.length), "base64url").toString("utf8")); }
  catch { throw new Error("the join token is damaged; copy it again from `barry workers invite`"); }
  const token = tokenSchema.parse(parsed);
  return { ...token, url: ownerUrl(token.url) };
}
