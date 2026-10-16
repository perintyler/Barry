// Keep tool credentials separate from the environment an adapter receives.
import { identityEnvironmentForId, setIdentityStore, type Environment } from "@barry-rocks/sdk/internal/env";
import { identityRecords } from "@barry-rocks/identities-bag";
import { createLogger } from "@barry-rocks/sdk/logging";

const log = createLogger("session-runtime");
setIdentityStore({ get: identityRecords.row, resolveConfig: identityRecords.config, touchLastUsed: identityRecords.touch });

export interface IdentityEnv {
  /** PATH and HOME, bare. */
  base: Record<string, string>;
  /** The built environment — null only when the session has no identity. */
  environment: Environment | null;
  /** OS essentials; callers add only the selected adapter/provider credentials. */
  vars: Record<string, string>;
}

const lastTouched = new Map<number, number>();

export async function resolveEnvForBarry(identityId: number | null | undefined): Promise<IdentityEnv> {
  const base: Record<string, string> = {
    PATH: process.env.PATH!,
    HOME: process.env.HOME!,
  };

  if (!identityId) return { base, environment: null, vars: base };

  // A session with an identity runs with that identity's environment or not at
  // all, as `barry start` does: running it without one would surface later as a
  // misleading missing-credential refusal, or as a turn missing its secrets.
  let environment: Environment;
  try {
    environment = await identityEnvironmentForId(identityId, { log, touch: false, cacheTtlMs: Math.max(0, Number(process.env.BARRY_IDENTITY_ENV_TTL_MS ?? 300_000)) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn("identity.environment_build_failed", { identityId, error: reason });
    throw new IdentityEnvironmentError(identityId, reason);
  }

  // Update last_used_at on the leaf identity only (fire-and-forget)
  if (Date.now() - (lastTouched.get(identityId) ?? 0) >= 60_000) {
  lastTouched.set(identityId, Date.now());
  identityRecords.touch(identityId).catch((err: unknown) => {
    log.warn("identity.last_used_update_failed", { identityId, error: err instanceof Error ? err.message : String(err) });
  });

  }
  return { base, environment, vars: { ...base } };
}

/** The session's identity could not supply its environment, so the turn does not run. */
export class IdentityEnvironmentError extends Error {
  constructor(readonly identityId: number, readonly reason: string) {
    super(`Identity ${identityId}'s environment could not be built (${reason}); the turn did not run. \`barry identity check\` names what is missing.`);
    this.name = "IdentityEnvironmentError";
  }
}
