import crypto from "node:crypto";
import http from "node:http";
import {
  deriveKeys,
  encrypt,
  decrypt,
  generateSymmetricKey,
  encryptSymmetricKey,
  decryptSymmetricKey,
  generateMasterPassword,
  generateKdfSalt,
} from "./crypto.js";
import { VaultError } from "./errors.js";

export interface VaultSession {
  accountId: string;
  token: string;
  encKey: Buffer;
  macKey: Buffer;
}
export type VaultAuth = VaultSession;

export interface VaultItem {
  id: string;
  name: string;
  username: string | null;
  password: string | null;
  uri: string | null;
  notes: string | null;
}

export interface VaultItemSummary {
  id: string;
  name: string;
  type: number;
}

export interface RegistrationResult {
  clientId: string;
  clientSecret: string;
  masterPassword: string;
}

export interface VaultClientOptions {
  registrationSecret?: string;
  /**
   * Waits before each retry of a rate-limited (429) request. The daemon
   * rate-limits, and a session resolving ~25 secrets trips it: every 429 used
   * to become a silently missing credential. Override only in tests.
   */
  rateLimitRetryDelaysMs?: readonly number[];
}

/** The daemon has no item by that name, as opposed to failing to answer. */
export class VaultItemNotFoundError extends VaultError {
  readonly itemName: string;

  constructor(itemName: string) {
    super("not-found", `Vault item "${itemName}" not found`);
    this.name = "VaultItemNotFoundError";
    this.itemName = itemName;
  }
}

/**
 * A typed error for a non-2xx answer, keeping the message text callers already
 * log. Only the TYPE is new: a caller can now switch on `kind` instead of
 * matching "(429)" in a string.
 */
async function statusError(message: string, res: { status: number; json(): Promise<unknown> }): Promise<VaultError> {
  const kind =
    res.status === 429 ? "rate-limited"
    : res.status === 401 || res.status === 403 ? "auth"
    : res.status === 404 ? "not-found"
    : "server";
  let retryAfterSeconds: number | undefined;
  if (kind === "rate-limited") {
    // The daemon puts the wait in the body — the socket transport exposes no
    // headers. Best effort: an unparsable body just means no hint.
    try {
      const body = (await res.json()) as { retryAfterSeconds?: unknown };
      if (typeof body.retryAfterSeconds === "number") retryAfterSeconds = body.retryAfterSeconds;
    } catch {
      // no body, no hint
    }
  }
  return new VaultError(kind, message, { retryAfterSeconds });
}

/**
 * A connection-level failure, typed by its errno. The message is the original
 * one, unchanged; the kind separates "no daemon" from "not allowed to connect"
 * (not in the _barryvault group), which read identically before.
 */
function transportError(err: unknown): VaultError {
  const code = (err as { code?: unknown; cause?: { code?: unknown } } | null)?.code
    ?? (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  const kind = code === "EACCES" || code === "EPERM" ? "permission" : "unreachable";
  return new VaultError(kind, err instanceof Error ? err.message : String(err), { cause: err });
}

const DEFAULT_RATE_LIMIT_RETRY_DELAYS_MS = [500, 1500, 4000] as const;

/**
 * A minimal Response-shaped result, enough for every call site below (`res.ok`,
 * `res.status`, `res.json()`). Not the DOM Response — a real one is used
 * unmodified for the http(s) path, so this only exists to give the unix-socket
 * path the same shape without pulling in a client library.
 */
interface VaultResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/**
 * Sends one HTTP request over a unix socket and adapts the reply to the same
 * shape `fetch` returns.
 *
 * No dependency was added for this: the vault transport needs no external HTTP client,
 * and Node's global `fetch` has no public way to target a socket path without
 * importing `undici` directly as a real dependency (its `dispatcher` option
 * takes an `undici.Agent`) — `node:http`'s own `socketPath` option does the
 * same thing with what Node already provides.
 */
function socketRequest(
  socketPath: string,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<VaultResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path,
        method: init.method ?? "GET",
        headers: init.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            ok: status >= 200 && status < 300,
            status,
            // Matches fetch()'s json(): throws on unparsable/empty body rather
            // than returning null, so callers that assume a shape fail the
            // same way against either transport.
            json: async () => JSON.parse(text),
          });
        });
      },
    );
    req.on("error", (err) => reject(transportError(err)));
    if (init.body) req.write(init.body);
    req.end();
  });
}

/** Whether a server URL names a unix socket rather than a host. */
function isSocketUrl(serverUrl: string): boolean {
  return serverUrl.startsWith("unix://");
}

/** The filesystem path encoded in a `unix://<path>` server URL. */
function socketPathOf(serverUrl: string): string {
  return serverUrl.slice("unix://".length);
}

/**
 * Remote vault hosts a client may speak https to. Empty on purpose.
 *
 * In code, not an env var: the URL a client dials decides where
 * master-password-derived hashes and API keys are sent, so an
 * agent-writable override would let one `export` redirect credentials. A
 * remote store is added here,
 * in a reviewed commit, and recorded wherever the vault's deployments are
 * listed — the plan calls for a deployments doc under the vault bag.
 */
const TRUSTED_REMOTE_VAULT_HOSTS: readonly string[] = [];

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Refuse a server URL that could send credentials somewhere untrusted.
 *
 * Accepted: `unix://` sockets; plain `http://` to loopback only (tests and
 * local debugging); `https://` only to an allowlisted host. Everything else
 * throws at construction — failing loudly beats a stray `VAULT_URL` quietly
 * shipping login material to whatever host it names.
 */
export function assertTrustedVaultUrl(serverUrl: string): void {
  if (isSocketUrl(serverUrl)) {
    if (!socketPathOf(serverUrl).startsWith("/")) {
      throw new VaultError("config", `Vault socket URL must name an absolute path: ${serverUrl}`);
    }
    return;
  }

  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new VaultError("config", `Vault server URL is not a URL: ${serverUrl}`);
  }

  if (url.username || url.password) {
    throw new VaultError("config", "Refusing a vault server URL that carries credentials (user:pass@)");
  }

  // `hostname` is the WHATWG-normalized host: decimal/octal/hex spellings of
  // 127.0.0.1 all normalize to "127.0.0.1" (they ARE loopback), while
  // look-alikes such as "127.0.0.1.evil.com" keep their full name — so an
  // exact set lookup is the whole check.
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return;
  if (url.protocol === "https:" && TRUSTED_REMOTE_VAULT_HOSTS.includes(url.hostname)) return;

  throw new VaultError(
    "config",
    `Refusing vault server URL ${url.protocol}//${url.host}: credentials may only be sent to the local ` +
      `socket, to loopback over http, or over https to a host in TRUSTED_REMOTE_VAULT_HOSTS ` +
      `(sdk/src/vault/client.ts). Check VAULT_URL and the identity's vault config.`,
  );
}

/**
 * Unwrap the account key, naming the likely cause when it does not unwrap.
 *
 * `/api/auth/api-key` never checks the email — it authenticates on the client
 * secret alone — so a wrong account email still logs in successfully. The
 * email only matters here, as part of the key-derivation salt, and a mismatch
 * surfaced as the bare "MAC verification failed" from the crypto: exactly the
 * reads-like-a-corrupt-vault misdiagnosis vaultEmail's comment in
 * credentials/index.ts exists to prevent. That comment guards the
 * missing-email case; this guards the wrong-email one.
 */
function unwrapAccountKey(
  encryptedKey: string,
  encKey: Buffer,
  macKey: Buffer,
  email: string,
): { encKey: Buffer; macKey: Buffer } {
  try {
    return decryptSymmetricKey(encryptedKey, encKey, macKey);
  } catch (err) {
    throw new VaultError(
      "decrypt",
      `Vault key could not be decrypted: the master password or the account email (${email}) ` +
        `does not match this account. The login itself succeeded, so this is not a corrupt vault.`,
      { cause: err },
    );
  }
}

export class VaultClient {
  private registrationSecret?: string;
  private itemLists = new WeakMap<VaultAuth, Promise<VaultItemSummary[]>>();

  private readonly serverUrl: string;

  private readonly rateLimitRetryDelaysMs: readonly number[];

  /** Require an explicit trusted Unix-socket or HTTP endpoint and validate it before sending credentials or requests; see docs/decisions/0014-discovery-vault-and-session-budgets.md. */
  constructor(serverUrl: string, opts?: VaultClientOptions) {
    assertTrustedVaultUrl(serverUrl);
    this.serverUrl = serverUrl;
    this.registrationSecret = opts?.registrationSecret;
    this.rateLimitRetryDelaysMs = opts?.rateLimitRetryDelaysMs ?? DEFAULT_RATE_LIMIT_RETRY_DELAYS_MS;
  }

  /** One request, retried with backoff while the daemon answers 429. */
  private async request(
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<VaultResponse | Response> {
    for (let attempt = 0; ; attempt++) {
      const res = isSocketUrl(this.serverUrl)
        ? await socketRequest(socketPathOf(this.serverUrl), path, init)
        : await fetch(`${this.serverUrl}${path}`, init).catch((err: unknown) => {
            throw transportError(err);
          });
      const delay = this.rateLimitRetryDelaysMs[attempt];
      if (res.status !== 429 || delay === undefined) return res;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  async register(email: string, masterPassword?: string): Promise<RegistrationResult> {
    const password = masterPassword ?? generateMasterPassword();
    const kdfSalt = generateKdfSalt();
    const { masterPasswordHash, encKey, macKey } = await deriveKeys(password, email, kdfSalt);

    const symKey = generateSymmetricKey();
    const encryptedKey = encryptSymmetricKey(symKey, encKey, macKey);

    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 4096,
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "der" },
    });

    const encryptedPrivateKey = encrypt(privateKey.toString("binary"), encKey, macKey);

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.registrationSecret) {
      headers["X-Registration-Secret"] = this.registrationSecret;
    }

    const res = await this.request("/api/accounts/register", {
      method: "POST",
      headers,
      body: JSON.stringify({
        email: email.toLowerCase(),
        masterPasswordHash,
        encryptedKey,
        kdfSalt,
        publicKey: publicKey.toString("base64"),
        encryptedPrivateKey,
      }),
    });

    if (!res.ok) {
      throw await statusError(`Registration failed (${res.status})`, res);
    }

    const data = await res.json() as { clientId: string; clientSecret: string };
    return { clientId: data.clientId, clientSecret: data.clientSecret, masterPassword: password };
  }

  /** Treat only a successful explicit null salt as a legacy account and propagate transport or server failures instead of deriving incompatible keys; see docs/decisions/0014-discovery-vault-and-session-budgets.md. */
  async getSalt(email: string): Promise<string | null> {
    const res = await this.request("/api/auth/salt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.toLowerCase() }),
    });
    if (!res.ok) {
      throw new VaultError(
        res.status === 429 ? "rate-limited" : "server",
        `Vault salt lookup failed (${res.status}); refusing to guess a salt, which would surface as a decryption failure`,
      );
    }
    const data = await res.json() as { salt: string | null };
    return data.salt;
  }

  private async authenticatedSession(data: { token: string; encryptedKey: string }, encKey: Buffer, macKey: Buffer, email: string): Promise<VaultAuth> {
    try {
      const itemKeys = unwrapAccountKey(data.encryptedKey, encKey, macKey, email);
      return { accountId: this.extractSub(data.token), token: data.token, encKey: itemKeys.encKey, macKey: itemKeys.macKey };
    } catch (error) {
      // Authentication can succeed before a wrong password/email fails local
      // decryption. No session is returned to the caller to close in that case.
      if (typeof data.token === "string" && data.token) {
        try { await this.request("/api/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${data.token}` } }); }
        catch { /* Lost cleanup evidence cannot replace the original key error. */ }
      }
      throw error;
    }
  }

  async login(email: string, masterPassword: string): Promise<VaultAuth> {
    const kdfSalt = await this.getSalt(email);
    const { masterPasswordHash, encKey, macKey } = await deriveKeys(masterPassword, email, kdfSalt);

    const res = await this.request("/api/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.toLowerCase(), masterPasswordHash }),
    });

    if (!res.ok) {
      throw await statusError(`Login failed (${res.status})`, res);
    }

    const data = await res.json() as { token: string; encryptedKey: string; kdfSalt: string | null };
    return this.authenticatedSession(data, encKey, macKey, email);
  }

  async loginWithApiKey(clientId: string, clientSecret: string, masterPassword: string, email: string): Promise<VaultAuth> {
    const kdfSalt = await this.getSalt(email);
    const { encKey, macKey } = await deriveKeys(masterPassword, email, kdfSalt);

    const res = await this.request("/api/auth/api-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, clientSecret }),
    });

    if (!res.ok) {
      throw await statusError(`API key auth failed (${res.status})`, res);
    }

    const data = await res.json() as { token: string; encryptedKey: string };
    return this.authenticatedSession(data, encKey, macKey, email);
  }

  async listItems(session: VaultAuth): Promise<VaultItemSummary[]> {
    let pending = this.itemLists.get(session);
    if (!pending) {
      pending = (async () => {
        const res = await this.authedFetch(session, "/api/items");
        const data = await res.json() as { items: Array<{ id: string; name: string; type: number }> };
        return data.items.map(item => ({ id: item.id, name: this.decryptField(item.name, session), type: item.type }));
      })();
      this.itemLists.set(session, pending);
      const request = pending;
      void request.catch(() => { if (this.itemLists.get(session) === request) this.itemLists.delete(session); });
    }
    return pending;
  }

  private async invalidateItems(): Promise<void> {
    this.itemLists = new WeakMap();
    // All identities sharing this vault can hold stale values in this process.
    (await import("../env/identity.js")).invalidateIdentityEnvironment();
  }

  async getItem(session: VaultAuth, name: string): Promise<VaultItem> {
    const items = await this.listItems(session);
    const match = items.find((i) => i.name === name);
    if (!match) throw new VaultItemNotFoundError(name);

    return this.getItemById(session, match.id);
  }

  async getItemById(session: VaultAuth, id: string): Promise<VaultItem> {
    const res = await this.authedFetch(session, `/api/items/${encodeURIComponent(id)}`);
    const raw = await res.json() as {
      id: string;
      name: string;
      username: string | null;
      password: string | null;
      uri: string | null;
      notes: string | null;
    };

    return {
      id: raw.id,
      name: this.decryptField(raw.name, session),
      username: raw.username ? this.decryptField(raw.username, session) : null,
      password: raw.password ? this.decryptField(raw.password, session) : null,
      uri: raw.uri ? this.decryptField(raw.uri, session) : null,
      notes: raw.notes ? this.decryptField(raw.notes, session) : null,
    };
  }

  async searchItems(session: VaultAuth, query: string): Promise<VaultItemSummary[]> {
    const items = await this.listItems(session);
    const q = query.toLowerCase();
    return items.filter((i) => i.name.toLowerCase().includes(q));
  }

  async createItem(
    session: VaultAuth,
    item: { name: string; username?: string; password?: string; uri?: string; notes?: string },
  ): Promise<string> {
    const body: Record<string, string | number | null> = {
      name: this.encryptField(item.name, session),
      type: 1,
    };
    if (item.username) body.username = this.encryptField(item.username, session);
    if (item.password) body.password = this.encryptField(item.password, session);
    if (item.uri) body.uri = this.encryptField(item.uri, session);
    if (item.notes) body.notes = this.encryptField(item.notes, session);

    const res = await this.authedFetch(session, "/api/items", {
      method: "POST",
      body: JSON.stringify(body),
    });

    const data = await res.json() as { id: string };
    await this.invalidateItems();
    return data.id;
  }

  async updateItem(
    session: VaultAuth,
    id: string,
    fields: Partial<{ name: string; username: string; password: string; uri: string; notes: string }>,
  ): Promise<void> {
    const body: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(fields)) {
      body[key] = value ? this.encryptField(value, session) : null;
    }

    await this.authedFetch(session, `/api/items/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    await this.invalidateItems();
  }

  async deleteItem(session: VaultAuth, id: string): Promise<void> {
    await this.authedFetch(session, `/api/items/${id}`, { method: "DELETE" });
    await this.invalidateItems();
  }

  async logout(session: VaultAuth): Promise<void> {
    this.itemLists.delete(session);
    await this.request("/api/auth/logout", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.token}`,
      },
    });
  }

  async status(): Promise<{ connected: boolean; serverUrl: string; error?: string }> {
    try {
      const res = await this.request("/health");
      return { connected: res.ok, serverUrl: this.serverUrl };
    } catch (err) {
      return { connected: false, serverUrl: this.serverUrl, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private extractSub(token: string): string {
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
      return payload.sub ?? "";
    } catch {
      return "";
    }
  }

  private encryptField(value: string, session: VaultAuth): string {
    return encrypt(value, session.encKey, session.macKey);
  }

  private decryptField(value: string, session: VaultAuth): string {
    return decrypt(value, session.encKey, session.macKey);
  }

  private async authedFetch(session: VaultAuth, path: string, init?: { method?: string; body?: string }): Promise<VaultResponse | Response> {
    const res = await this.request(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.token}`,
      },
    });

    if (!res.ok) {
      throw await statusError(`Vault API error (${res.status})`, res);
    }

    return res;
  }
}
