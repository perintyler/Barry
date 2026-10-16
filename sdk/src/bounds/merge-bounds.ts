import type { AllowDeny, Bound } from "./types.js";

function unionArrays<T extends string>(a?: readonly T[], b?: readonly T[]): T[] | undefined {
  const combined = [...(a ?? []), ...(b ?? [])];
  return combined.length > 0 ? [...new Set(combined)] : undefined;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split("**")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * True when every candidate matched by `narrow` is also matched by `broad`.
 */
function patternCovers(broad: string, narrow: string): boolean {
  if (broad === narrow) return true;
  if (broad === "*" || broad === "**" || broad === "*:*") return true;

  if (broad.endsWith("/**")) {
    const prefix = broad.slice(0, -3).replace(/\/+$/, "");
    if (narrow === prefix || narrow.startsWith(`${prefix}/`)) return true;
  }
  if (broad.endsWith("/*")) {
    const prefix = broad.slice(0, -2).replace(/\/+$/, "");
    if (narrow.startsWith(`${prefix}/`)) {
      const rest = narrow.slice(prefix.length + 1);
      if (!rest.includes("/") && rest !== "**") return true;
    }
  }
  if (broad.startsWith("*.") && !broad.slice(2).includes("*")) {
    const suffix = broad.slice(1); // ".example.com"
    if (narrow.endsWith(suffix) && narrow.length > suffix.length) return true;
  }
  if (!broad.includes(":") && narrow.startsWith(`${broad}:`)) {
    return true;
  }
  if (broad.endsWith(":*") && narrow.startsWith(broad.slice(0, -1))) {
    return true;
  }
  if (broad.startsWith("*:") && narrow.endsWith(broad.slice(1))) {
    return true;
  }
  if (!narrow.includes("*")) {
    return globToRegExp(broad).test(narrow);
  }
  return false;
}

function fixedPrefix(pattern: string): string {
  const idx = pattern.indexOf("*");
  return idx === -1 ? pattern : pattern.slice(0, idx);
}

/**
 * True when two glob patterns could potentially match a common string even
 * though neither syntactically subsumes the other.
 */
function globsCanOverlap(a: string, b: string): boolean {
  if (!a.includes("*") && !b.includes("*")) return a === b;
  const prefA = fixedPrefix(a);
  const prefB = fixedPrefix(b);
  if (prefA && prefB && !prefA.startsWith(prefB) && !prefB.startsWith(prefA)) {
    return false;
  }
  return true;
}

function clausesOf(rule?: AllowDeny): string[][] | undefined {
  if (!rule) return undefined;
  if (rule.allowClauses?.length) return rule.allowClauses.map((c) => [...new Set(c)]);
  if (rule.allow !== undefined) return [[...new Set(rule.allow)]];
  return undefined;
}

function intersectTwoClauses(
  clauseA: string[],
  clauseB: string[],
): { collapsed: string[] } | { conjunctive: [string[], string[]] } {
  if (clauseA.length === 0 || clauseB.length === 0) {
    return { collapsed: [] };
  }
  const narrowed: string[] = [];
  let hasOrthogonalOverlap = false;

  for (const a of clauseA) {
    for (const b of clauseB) {
      if (patternCovers(a, b)) {
        narrowed.push(b);
      } else if (patternCovers(b, a)) {
        narrowed.push(a);
      } else if (globsCanOverlap(a, b)) {
        hasOrthogonalOverlap = true;
      }
    }
  }

  if (!hasOrthogonalOverlap) {
    return { collapsed: [...new Set(narrowed)] };
  }
  return { conjunctive: [[...new Set(clauseA)], [...new Set(clauseB)]] };
}

export function mergeAllowDeny(a?: AllowDeny, b?: AllowDeny): AllowDeny | undefined {
  if (!a && !b) return undefined;
  const deny = unionArrays(a?.deny, b?.deny);
  const clausesA = clausesOf(a);
  const clausesB = clausesOf(b);

  let allow: string[] | undefined;
  let allowClauses: string[][] | undefined;

  if (clausesA === undefined && clausesB === undefined) {
    allow = undefined;
  } else if (clausesA === undefined) {
    if (clausesB!.length === 1) {
      allow = clausesB![0];
    } else {
      allow = clausesB![0];
      allowClauses = clausesB;
    }
  } else if (clausesB === undefined) {
    if (clausesA.length === 1) {
      allow = clausesA[0];
    } else {
      allow = clausesA[0];
      allowClauses = clausesA;
    }
  } else {
    const combinedClauses = [...clausesA, ...clausesB];
    if (combinedClauses.some((c) => c.length === 0)) {
      allow = [];
    } else if (clausesA.length === 1 && clausesB.length === 1) {
      const intersected = intersectTwoClauses(clausesA[0], clausesB[0]);
      if ("collapsed" in intersected) {
        allow = intersected.collapsed;
      } else {
        allow = intersected.conjunctive[0];
        allowClauses = intersected.conjunctive;
      }
    } else {
      allow = combinedClauses[0];
      allowClauses = combinedClauses;
    }
  }

  if (allow === undefined && deny === undefined && allowClauses === undefined) {
    return undefined;
  }
  return {
    ...(allow !== undefined ? { allow } : {}),
    ...(deny !== undefined ? { deny } : {}),
    ...(allowClauses !== undefined ? { allowClauses } : {}),
  };
}

function normalizeInputRule(rule: unknown): AllowDeny | undefined {
  if (typeof rule === "string") return { allow: [rule] };
  if (Array.isArray(rule)) return { allow: rule.map(String) };
  if (rule && typeof rule === "object") {
    const obj = rule as AllowDeny;
    const allow = obj.allow !== undefined ? [...new Set(obj.allow)] : undefined;
    const deny = obj.deny?.length ? [...new Set(obj.deny)] : undefined;
    const allowClauses = obj.allowClauses?.length ? obj.allowClauses.map((c) => [...new Set(c)]) : undefined;
    if (allow === undefined && deny === undefined && allowClauses === undefined) return undefined;
    return {
      ...(allow !== undefined ? { allow } : {}),
      ...(deny !== undefined ? { deny } : {}),
      ...(allowClauses !== undefined ? { allowClauses } : {}),
    };
  }
  return undefined;
}

export function mergeInputs(
  a?: Record<string, Record<string, AllowDeny>>,
  b?: Record<string, Record<string, AllowDeny>>,
): Record<string, Record<string, AllowDeny>> | undefined {
  if (!a && !b) return undefined;
  const toolIds = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  const merged: Record<string, Record<string, AllowDeny>> = {};
  for (const toolId of toolIds) {
    const paramsA = a?.[toolId];
    const paramsB = b?.[toolId];
    const paramNames = new Set([...Object.keys(paramsA ?? {}), ...Object.keys(paramsB ?? {})]);
    const mergedParams: Record<string, AllowDeny> = {};
    for (const param of paramNames) {
      const rule = mergeAllowDeny(
        normalizeInputRule(paramsA?.[param]),
        normalizeInputRule(paramsB?.[param]),
      );
      if (rule) mergedParams[param] = rule;
    }
    if (Object.keys(mergedParams).length > 0) {
      merged[toolId] = mergedParams;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function mergeNetwork(
  a?: Bound["network"],
  b?: Bound["network"],
): Bound["network"] | undefined {
  if (!a && !b) return undefined;

  const base = mergeAllowDeny(a, b);
  const enforce =
    a?.enforce === "sandbox" || b?.enforce === "sandbox"
      ? "sandbox"
      : a?.enforce ?? b?.enforce;

  if (!base && !enforce) {
    return undefined;
  }
  return {
    ...(base ?? {}),
    ...(enforce ? { enforce } : {}),
  };
}

function hasAllowDeny(dim?: AllowDeny): boolean {
  return Boolean(
    dim &&
      (dim.allow !== undefined ||
        (dim.allowClauses && dim.allowClauses.length > 0) ||
        (dim.deny && dim.deny.length > 0)),
  );
}

export function boundHasContent(bound?: Bound | null): boolean {
  if (!bound) return false;
  return Boolean(
    hasAllowDeny(bound.tools) ||
      (bound.inputs &&
        Object.values(bound.inputs).some((paramRules) =>
          Object.values(paramRules).some((rule) => hasAllowDeny(rule)),
        )) ||
      hasAllowDeny(bound.files) ||
      hasAllowDeny(bound.bash) ||
      hasAllowDeny(bound.network) ||
      bound.network?.enforce ||
      hasAllowDeny(bound.nodes),
  );
}

function mergeTwoBounds(a?: Bound | null, b?: Bound | null): Bound | null {
  if (!a && !b) return null;

  const tools = mergeAllowDeny(a?.tools, b?.tools);
  const inputs = mergeInputs(a?.inputs, b?.inputs);
  const files = mergeAllowDeny(a?.files, b?.files);
  const bash = mergeAllowDeny(a?.bash, b?.bash);
  const network = mergeNetwork(a?.network, b?.network);
  const nodes = mergeAllowDeny(a?.nodes, b?.nodes);

  const merged: Bound = {
    ...(tools ? { tools } : {}),
    ...(inputs ? { inputs } : {}),
    ...(files ? { files } : {}),
    ...(bash ? { bash } : {}),
    ...(network ? { network } : {}),
    ...(nodes ? { nodes } : {}),
  };

  return boundHasContent(merged) ? merged : null;
}

/**
 * Merge any number of bounds into a single effective `Bound`.
 *
 * Across all 6 dimensions (`tools`, `inputs`, `files`, `bash`, `network`, `nodes`),
 * `deny` lists union and `allow` lists intersect (preserving conjunctive clauses
 * when glob patterns are orthogonal). Returns `null` when the merged result has
 * no restrictions.
 */
export function mergeBounds(...bounds: (Bound | null | undefined)[]): Bound | null {
  let acc: Bound | null = null;
  for (const bound of bounds) {
    acc = mergeTwoBounds(acc, bound);
  }
  return acc;
}
