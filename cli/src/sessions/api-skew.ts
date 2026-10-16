import { span } from "../lib/timing.js";
import { readRelease, releaseRoot } from "../releases/release.js";
import { CliError } from "../lib/cli-error.js";
import { apiRequest } from "./api-request.js";

export interface CliBuild { commit?: string; version?: string; stores: Record<string, number> }
export interface ApiHealth { build?: { release?: { commit: string; version: string } | null; schema?: Record<string, number> } }
export interface Skew { kind: "none" | "api-older" | "api-newer" | "unknown"; detail: string }
function version(value: string): number[] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match?.slice(1).map(Number);
}
export function classifySkew(ours: CliBuild, evidence: { health?: ApiHealth; errorText?: string }): Skew {
  const mismatch = /(\S+\.db) is at version (\d+), but this build only knows (\d+)/.exec(evidence.errorText ?? "");
  if (mismatch && Number(mismatch[2]) > Number(mismatch[3])) {
    const name = mismatch[1].split("/").at(-1)!.replace(/\.db$/, "");
    if (ours.stores[name] !== undefined && Number(mismatch[2]) > ours.stores[name]) return { kind: "api-newer", detail: `${name}.db v${mismatch[2]} exceeds CLI ${ours.stores[name]}` };
    return { kind: "api-older", detail: `${mismatch[1]} v${mismatch[2]} vs ${mismatch[3]}` };
  }
  const build = evidence.health?.build;
  if (!build) return { kind: "unknown", detail: "API build information is unavailable" };
  const differences = Object.entries(ours.stores).flatMap(([name, schema]) => typeof build.schema?.[name] === "number" ? [{ name, ours: schema, theirs: build.schema[name] }] : []);
  const newer = differences.find(item => item.theirs > item.ours);
  if (newer) return { kind: "api-newer", detail: `${newer.name}.db v${newer.theirs} vs CLI ${newer.ours}` };
  const older = differences.find(item => item.theirs < item.ours);
  if (older) return { kind: "api-older", detail: `${older.name}.db v${older.ours} vs ${older.theirs}` };
  if (ours.commit && build.release?.commit === ours.commit) return { kind: "none", detail: "API and CLI commits match" };
  const oursVersion = ours.version && version(ours.version), theirsVersion = build.release && version(build.release.version);
  if (oursVersion && theirsVersion) {
    for (let index = 0; index < 3; index++) {
      if (oursVersion[index] !== theirsVersion[index]) return { kind: oursVersion[index] > theirsVersion[index] ? "api-older" : "api-newer", detail: `API ${build.release!.version}, CLI ${ours.version}` };
    }
    if (ours.commit && build.release?.commit !== ours.commit) return { kind: "unknown", detail: "Equal release versions have different commits" };
  }
  return differences.length ? { kind: "none", detail: "API and CLI schemas match" } : { kind: "unknown", detail: "API build cannot be compared" };
}

export interface ApiCurrentDeps {
  base: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  restart?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  write?: (message: string) => void;
  noRestart?: boolean;
  pollMs?: number;
}
export async function cliBuild(): Promise<CliBuild> {
  const release = readRelease(releaseRoot());
  const { MIGRATIONS } = await import("@barry-rocks/sessions-bag/store/sessions-db");
  return { ...(release ? { commit: release.commit, version: release.version } : {}), stores: { sessions: MIGRATIONS.length } };
}

/** Start the cheap health probe alongside identity selection, then consume it at create. */
export function ensureApiCurrent(ours: Promise<CliBuild> | CliBuild, deps: ApiCurrentDeps) {
  const request = deps.fetch ?? fetch;
  let healthFailure: unknown;
  const health = async (): Promise<ApiHealth | undefined> => {
    try {
      // Build currency needs the I/O-free endpoint, not readiness statistics
      // over the entire session history. Older servers may lack this route.
      let response = await apiRequest(request, `${deps.base}/health/live`, { headers: deps.headers }, 1500);
      if (response.status === 404) response = await apiRequest(request, `${deps.base}/health`, { headers: deps.headers }, 1500);
      return response.ok ? await response.json() as ApiHealth : undefined;
    } catch (error) { healthFailure = error; return undefined; }
  };
  const initial = span("api:health", () => health());
  let restarted = false;
  const evaluate = async (evidence: { health?: ApiHealth; errorText?: string }): Promise<boolean> => {
    const classification = classifySkew(await ours, evidence);
    if (classification.kind === "api-newer") throw new CliError(`Barry's API is running a newer build (${classification.detail}); run: barry upgrade / rebuild this checkout`, 1);
    if (classification.kind !== "api-older") return false;
    if (deps.noRestart || process.env.BARRY_NO_SERVICE_RESTART === "1") throw new CliError(`Barry's API is running an older build (${classification.detail}); automatic restart is disabled. Run: barry service restart sessions.api`, 1);
    if (restarted) throw new CliError("Barry's API is still running an older build after restart. Run: barry service restart sessions.api", 1);
    restarted = true;
    (deps.write ?? console.warn)(`Barry's API is running an older build (${classification.detail}); restarting it…`);
    const restart = deps.restart ?? (async () => { const { installedServices } = await import("../services/barry.js"); await (await installedServices()).apply("sessions.api", "restart"); });
    try { await restart(); }
    catch (error) { throw new CliError(`Could not restart Barry's API: ${error instanceof Error ? error.message : String(error)}. Run: barry service restart sessions.api`, 1); }
    const now = deps.now ?? Date.now, deadline = now() + (deps.pollMs ?? 10_000);
    do {
      const current = await health();
      if (current) {
        const verdict = classifySkew(await ours, { health: current });
        if (verdict.kind === "none") return true;
        if (verdict.kind === "api-newer") throw new CliError(`Restarted API is newer than this CLI (${verdict.detail}); run: barry upgrade / rebuild this checkout`, 1);
      }
      await (deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(100);
    } while (now() < deadline);
    throw new CliError(`Barry's API did not become current at ${deps.base}. Run: barry service restart sessions.api`, 1);
  };
  return {
    beforeCreate: async (createRequired = true) => {
      const current = await initial;
      if (!current && healthFailure) {
        const warning = healthFailure instanceof Error ? healthFailure.message : String(healthFailure);
        if (!createRequired) return { ok: false as const, warning };
        // Hosted/bound creation remains mandatory; probe failure is no evidence of skew.
        (deps.write ?? console.warn)(`Warning: API build check unavailable; attempting session creation. ${warning}`);
        return { ok: true as const };
      }
      await evaluate({ health: current });
      return { ok: true as const };
    },
    retryCreate: async (errorText: string) => {
      const evidence = { errorText };
      if (classifySkew(await ours, evidence).kind !== "api-older") return false;
      return evaluate(evidence);
    },
  };
}
