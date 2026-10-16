/**
 * Obtain session namespaces from the server’s filtered tool set, including selected namespaces and scope; separate MCP config keys preserve per-namespace prefixes.
 * See docs/decisions/0011-sdk-runtime-invariants.md for the retained rationale.
 */

import { getServicePort } from "../services/config.js";

/** Env flag gating the split. Unset/false reproduces pre-split behavior exactly. */
export const NAMESPACE_SPLIT_ENV = "BARRY_NAMESPACE_SPLIT";

export function isNamespaceSplitEnabled(): boolean {
  const raw = process.env[NAMESPACE_SPLIT_ENV];
  return raw === "1" || raw === "true";
}

export interface ResolveSessionNamespacesOptions {
  /** Used when the server is unreachable. Typically trait-derived namespaces. */
  fallback?: string[];
  /** Overrides the MCP base URL (tests, non-default ports). */
  baseUrl?: string;
  timeoutMs?: number;
  enabled?:boolean;
}

/**
 * Namespaces the session resolves to, or `[]` when splitting is disabled.
 *
 * Never throws: a namespace-resolution failure must degrade to the old
 * single-server behavior, never block starting a session.
 */
export async function resolveSessionNamespaces(
  sessionId: string | undefined,
  options: ResolveSessionNamespacesOptions = {},
): Promise<string[]> {
  if (!(options.enabled??isNamespaceSplitEnabled())) return [];
  if (!sessionId) return dedupe(options.fallback ?? []);

  const base = options.baseUrl ?? `http://127.0.0.1:${getServicePort("mcpBarry")}`;
  const timeoutMs = options.timeoutMs ?? 3000;

  try {
    const secret = process.env.BARRY_SECRET;
    const headers: Record<string, string> = {};
    if (secret) headers.Authorization = `Bearer ${secret}`;

    const res = await fetch(
      `${base}/session-namespaces?sessionId=${encodeURIComponent(sessionId)}`,
      { headers, signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!res.ok) return dedupe(options.fallback ?? []);

    const body = (await res.json()) as { namespaces?: unknown };
    if (!Array.isArray(body.namespaces)) return dedupe(options.fallback ?? []);

    const namespaces = body.namespaces.filter((n): n is string => typeof n === "string" && !!n);
    // An empty server response is authoritative only if the session genuinely has
    // no tools; falling back keeps a misconfigured session usable.
    return namespaces.length > 0 ? dedupe(namespaces) : dedupe(options.fallback ?? []);
  } catch {
    return dedupe(options.fallback ?? []);
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}
