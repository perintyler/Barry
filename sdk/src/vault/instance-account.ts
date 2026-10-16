/** Installation-owned named connections. Identity configuration carries only a name. */
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { z } from "zod";
import { parseEnv } from "node:util";
import { barryConfigDir, barryEnvPath } from "../services/home.mjs";
import { SecretNameSchema } from "../identities/secrets.js";
import { assertTrustedVaultUrl } from "./client.js";
import { VaultError } from "./errors.js";

const reference = z.strictObject({ in: z.literal(".env"), key: SecretNameSchema });
const connection = z.strictObject({
  server_url: z.string().min(1).max(2000).regex(/^[^\0\r\n]+$/),
  bootstrap: z.strictObject({ client_id: reference, client_secret: reference, master_password: reference, email: reference }),
});
const envelope = z.strictObject({ version: z.literal(1), accounts: z.record(z.string(), z.unknown()) });
type Connection = z.infer<typeof connection>;
const failure = () => new VaultError("config", "Configured vault account needs a valid private connection and bootstrap file.");

// Automatic instance bootstrap must not turn an ordinary test into a real
// installation credential read. The existing deliberate real-vault opt-out
// remains test-only; this component's qualification never uses it.
function fixtureRoot(): string | undefined {
  if (!process.env.VITEST || process.env.BARRY_ALLOW_REAL_VAULT === "1") return undefined;
  try {
    if (!process.env.BARRY_HOME) throw failure();
    const root = realpathSync(process.env.BARRY_HOME), path = relative(realpathSync(tmpdir()), root);
    if (!path || path === ".." || path.startsWith("../") || isAbsolute(path)) throw failure();
    return root;
  } catch { throw new VaultError("config", "openVault() refuses to open a real vault under VITEST without a temporary instance."); }
}

/** Open the actual inode once; no symlink, permissive replacement, or ambient values. */
function privateFile(filename: string, limit: number, optional = false): string | undefined {
  const testRoot = fixtureRoot();
  let fd: number;
  try {
    if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_NONBLOCK)) throw failure();
    fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw failure();
  }
  try {
    const file = fstatSync(fd), parent = statSync(dirname(filename)), uid = process.getuid?.();
    if (testRoot) {
      const path = relative(testRoot, realpathSync(dirname(filename)));
      if (path === ".." || path.startsWith("../") || isAbsolute(path)) throw failure();
    }
    if (!file.isFile() || (file.mode & 0o077) !== 0 || file.size > limit
      || !parent.isDirectory() || (parent.mode & 0o022) !== 0
      || uid !== undefined && (file.uid !== uid || parent.uid !== uid && parent.uid !== 0)) throw failure();
    const bytes = Buffer.allocUnsafe(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > limit) throw failure();
    return bytes.toString("utf8", 0, length);
  } catch { throw failure(); }
  finally { closeSync(fd); }
}

function selectedConnection(name: string): Connection | undefined {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) throw failure();
  const contents = privateFile(join(barryConfigDir(), "vault-accounts.yaml"), 262_144, true);
  if (contents === undefined) return undefined;
  try {
    const configured = envelope.parse(parse(contents));
    if (!Object.hasOwn(configured.accounts, name)) return undefined;
    // A malformed account must not invalidate another independently named account.
    const selected = connection.parse(configured.accounts[name]);
    assertTrustedVaultUrl(selected.server_url);
    return selected;
  } catch { throw failure(); }
}

/** Nonsecret endpoint/presence query for host administration; never reads bootstrap values. */
export function configuredVaultEndpoint(name: string): string | undefined {
  return selectedConnection(name)?.server_url;
}

/** Read all four slots from one verified private inode per opening, never process.env. */
export function instanceVaultConnection(name: string): {
  serverUrl: string;
  readSecret(service: string, account: string): Promise<string | null>;
} | undefined {
  const selected = selectedConnection(name);
  if (!selected) return undefined;
  const slots = new Map<string, keyof Connection["bootstrap"]>([
    [`vault-${name}-client-id`, "client_id"], [`vault-${name}-client-secret`, "client_secret"],
    [`vault-${name}-master-password`, "master_password"], [`vault-${name}-email`, "email"],
  ]);
  let values: Record<string, string> | undefined;
  return {
    serverUrl: selected.server_url,
    async readSecret(service, account) {
      const field = slots.get(account);
      if (service !== "barry" || !field) throw failure();
      if (!values) {
        try {
          const contents = privateFile(barryEnvPath(), 1_048_576)!;
          const parsed = parseEnv(contents) as Record<string, string | undefined>;
          const read: Record<string, string> = {};
          for (const [field, reference] of Object.entries(selected.bootstrap)) {
            const value = parsed[reference.key];
            if (!value || value.length > 65_536) throw failure();
            read[field] = value;
          }
          values = read;
        } catch { throw failure(); }
      }
      return values[field];
    },
  };
}
