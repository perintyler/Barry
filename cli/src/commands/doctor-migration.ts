import { copyFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { barryBackupsDir } from "@barry-rocks/sdk/services";

const BARE_NATIVE_TOOLS = new Set([
  "bash",
  "write",
  "edit",
  "read",
  "glob",
  "grep",
  "webfetch",
  "websearch",
  "notebookedit",
  "multiedit",
]);

const CANONICAL_NATIVE_CASE: Record<string, string> = {
  bash: "Bash",
  write: "Write",
  edit: "Edit",
  read: "Read",
  glob: "Glob",
  grep: "Grep",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  notebookedit: "NotebookEdit",
  multiedit: "MultiEdit",
};

const BASE_IDENTITY_BAGS = new Set(["artifacts", "bash", "filesystem", "instructions", "sessions"]);

const RETIRED_COMPOSITE_TRAITS = new Set([
  "coding",
  "all",
  "default",
  "native-file-reads",
  "native-file-writes",
  "native-shell",
  "native-network",
]);

export const SHIPPED_GLOBAL_BOUND_NAMES = [
  "readonly",
  "no-secrets",
  "no-network",
  "no-network-write",
  "sandboxed-offline",
] as const;

const HISTORICAL_SHIPPED_BOUND_NAMES = new Set<string>([
  ...SHIPPED_GLOBAL_BOUND_NAMES,
  "safe",
  "sandboxed",
  "local-only",
  "no-bash",
  "slack-self-dm-only",
  "self-dm-only",
  "no-files",
]);

export interface TraitRowSummary {
  name: string;
  access?: string;
  namespaces: string[];
  boundNames: string[];
  bound: Record<string, unknown> | null;
  bag?: string | null;
}

function normalizeHarnessAlias(harness: string): string {
  if (harness === "claude") return "claude-code";
  if (harness === "default") return "*";
  return harness;
}

function normalizeDeniedToolName(tool: string): string {
  if (tool.includes(":")) return tool;
  const lower = tool.toLowerCase();
  if (BARE_NATIVE_TOOLS.has(lower)) {
    return `*:${CANONICAL_NATIVE_CASE[lower] ?? tool}`;
  }
  return tool;
}

/**
 * Return true when `raw` (or a nested `.bound` wrapper) contains any legacy
 * pre-6-dimension `Bound` keys.
 */
export function hasLegacyBoundKeys(
  raw: unknown,
  options?: { allowNestedBoundWrapper?: boolean },
): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const obj = raw as Record<string, unknown>;
  if ("bound" in obj && obj.bound && typeof obj.bound === "object") {
    return options?.allowNestedBoundWrapper ? hasLegacyBoundKeys(obj.bound) : true;
  }
  if ("deniedTools" in obj || "deniedAccess" in obj || "native" + "Tools" in obj) {
    return true;
  }
  const files = obj.files as Record<string, unknown> | undefined;
  if (files && typeof files === "object" && "allowOnly" in files) {
    return true;
  }
  const bash = obj.bash as Record<string, unknown> | undefined;
  if (bash && typeof bash === "object" && "denyPrograms" in bash) {
    return true;
  }
  const net = obj.network as Record<string, unknown> | undefined;
  if (
    net &&
    typeof net === "object" &&
    ("actions" in net || "domains" in net || "allowDomains" in net)
  ) {
    return true;
  }
  return false;
}

/**
 * Pure helper converting legacy `Bound` objects to the uniform 6-dimension
 * `{ allow, deny }` schema while preserving already-migrated fields.
 */
export function convertLegacyBound(raw: Record<string, unknown>): Record<string, unknown> {
  const inner =
    "bound" in raw && raw.bound && typeof raw.bound === "object" && !Array.isArray(raw.bound)
      ? (raw.bound as Record<string, unknown>)
      : raw;

  const out: Record<string, unknown> = {};
  const description =
    typeof raw.description === "string"
      ? raw.description
      : typeof inner.description === "string"
        ? inner.description
        : undefined;
  if (description) out.description = description;
  if (raw.optional === true || inner.optional === true) out.optional = true;

  const existingTools =
    inner.tools && typeof inner.tools === "object" && !Array.isArray(inner.tools)
      ? (inner.tools as { allow?: string[]; deny?: string[] })
      : undefined;
  const toolsDeny: string[] = [...(existingTools?.deny ?? [])];
  const addDeny = (pattern: string) => {
    if (!toolsDeny.includes(pattern)) toolsDeny.push(pattern);
  };

  if (Array.isArray(inner.deniedAccess)) {
    for (const acc of inner.deniedAccess) {
      if (acc === "write") addDeny("*:write");
      else if (acc === "read") addDeny("*:read");
    }
  }
  if (Array.isArray(inner.deniedTools)) {
    for (const t of inner.deniedTools) {
      if (typeof t === "string") addDeny(normalizeDeniedToolName(t));
    }
  }
  const legacyNativeKey = "native" + "Tools";
  if (inner[legacyNativeKey] && typeof inner[legacyNativeKey] === "object" && !Array.isArray(inner[legacyNativeKey])) {
    for (const [harnessKey, list] of Object.entries(inner[legacyNativeKey] as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const harness = normalizeHarnessAlias(harnessKey);
      for (const tool of list) {
        if (typeof tool === "string") addDeny(`${harness}:${tool}`);
      }
    }
  }

  const toolsOut: Record<string, unknown> = {};
  if (existingTools?.allow !== undefined) toolsOut.allow = [...existingTools.allow];
  if (toolsDeny.length > 0 || existingTools?.deny !== undefined) {
    toolsOut.deny = toolsDeny;
  }
  if (Object.keys(toolsOut).length > 0) out.tools = toolsOut;

  if (inner.inputs && typeof inner.inputs === "object" && !Array.isArray(inner.inputs)) {
    out.inputs = inner.inputs;
  }

  if (inner.files && typeof inner.files === "object" && !Array.isArray(inner.files)) {
    const f = inner.files as { allow?: string[]; allowOnly?: string[]; deny?: string[] };
    const filesOut: Record<string, unknown> = {};
    if (f.allow !== undefined) filesOut.allow = [...f.allow];
    else if (f.allowOnly !== undefined) filesOut.allow = [...f.allowOnly];
    if (f.deny !== undefined) filesOut.deny = [...f.deny];
    if (Object.keys(filesOut).length > 0) out.files = filesOut;
  }

  if (inner.bash && typeof inner.bash === "object" && !Array.isArray(inner.bash)) {
    const b = inner.bash as { allow?: string[]; deny?: string[]; denyPrograms?: string[] };
    const bashOut: Record<string, unknown> = {};
    if (b.allow !== undefined) bashOut.allow = [...b.allow];
    const bashDeny = [...new Set([...(b.deny ?? []), ...(b.denyPrograms ?? [])])];
    if (bashDeny.length > 0 || b.deny !== undefined) bashOut.deny = bashDeny;
    if (Object.keys(bashOut).length > 0) out.bash = bashOut;
  }

  if (inner.network && typeof inner.network === "object" && !Array.isArray(inner.network)) {
    const n = inner.network as {
      enforce?: string;
      allow?: string[];
      allowDomains?: string[];
      deny?: string[];
      actions?: string[];
      domains?: string[];
    };
    const netOut: Record<string, unknown> = {};
    if (n.enforce !== undefined) netOut.enforce = n.enforce;
    if (n.allow !== undefined) netOut.allow = [...n.allow];
    else if (n.allowDomains !== undefined) netOut.allow = [...n.allowDomains];

    const netDeny: string[] = [...(n.deny ?? [])];
    const addNetDeny = (item: string) => {
      if (!netDeny.includes(item)) netDeny.push(item);
    };
    if (Array.isArray(n.actions) && n.actions.length > 0) {
      if (n.actions.includes("all") || (n.actions.includes("read") && n.actions.includes("write"))) {
        addNetDeny("all");
      } else if (n.actions.includes("write")) {
        addNetDeny("write");
      } else if (n.actions.includes("read")) {
        addNetDeny("read");
      }
    }
    if (Array.isArray(n.domains)) {
      for (const d of n.domains) {
        if (typeof d === "string") addNetDeny(d);
      }
    }
    if (netDeny.length > 0 || n.deny !== undefined) netOut.deny = netDeny;
    if (Object.keys(netOut).length > 0) out.network = netOut;
  }

  if (inner.nodes && typeof inner.nodes === "object" && !Array.isArray(inner.nodes)) {
    out.nodes = inner.nodes;
  }

  return out;
}

function expandTraitSelection(
  legacyEntryNames: readonly string[],
  traitsTableMap: ReadonlyMap<string, TraitRowSummary>,
  installedBagNames?: ReadonlySet<string>,
): {
  bags: string[];
  bounds: string[];
  synthesizedBounds: Array<{ name: string; bound: Record<string, unknown> }>;
} {
  const bags: string[] = [];
  const bounds: string[] = [];
  const synthesizedBounds: Array<{ name: string; bound: Record<string, unknown> }> = [];
  const addBag = (name: string) => {
    if (name && !bags.includes(name)) bags.push(name);
  };
  const addBound = (name: string) => {
    if (name && !bounds.includes(name)) bounds.push(name);
  };

  for (const rawName of legacyEntryNames) {
    if (!rawName || RETIRED_COMPOSITE_TRAITS.has(rawName) || rawName.includes(":native-")) {
      continue;
    }
    if (rawName === "read" || rawName === "readonly") {
      addBound("readonly");
      continue;
    }
    if (rawName === "coding:IC" || rawName === "coding:ic") {
      addBag("coding");
      addBound("coding:ic");
      continue;
    }
    if (rawName === "slack:slack-me" || rawName === "slack:self-dm-only") {
      addBag("slack");
      addBound("slack:self-dm-only");
      continue;
    }
    if (rawName.endsWith(":read") && rawName.length > ":read".length) {
      const bagName = rawName.slice(0, -":read".length);
      addBag(bagName);
      addBound(`${bagName}:read`);
      continue;
    }

    const row = traitsTableMap.get(rawName);
    if (row) {
      for (const ns of row.namespaces) {
        addBag(ns);
      }
      if (row.bag) addBag(row.bag);
      if (row.access === "read" && row.namespaces.length === 1) {
        addBound(`${row.namespaces[0]}:read`);
      }
      for (const bName of row.boundNames) {
        addBound(bName);
      }
      if (row.bound && Object.keys(row.bound).length > 0) {
        const converted = convertLegacyBound(row.bound);
        if (Object.keys(converted).length > 0) {
          const synthName = `migrated-trait-${rawName.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
          synthesizedBounds.push({
            name: synthName,
            bound: {
              description:
                typeof converted.description === "string"
                  ? converted.description
                  : `Restrictions migrated from trait '${rawName}'`,
              ...converted,
            },
          });
          addBound(synthName);
        }
      }
      continue;
    }

    if (!installedBagNames || installedBagNames.has(rawName)) {
      addBag(rawName);
    } else if (rawName.includes(":")) {
      const [prefix] = rawName.split(":");
      if (prefix) addBag(prefix);
      addBound(rawName);
    } else {
      addBag(rawName);
    }
  }

  return { bags, bounds, synthesizedBounds };
}

function normalizeBagEntryList(
  rawBags: unknown,
  makeNonBaseOptional: boolean,
): Array<{ name: string; optional: boolean; extraConfig: Record<string, unknown> }> {
  const seen = new Map<string, { optional: boolean; extraConfig: Record<string, unknown> }>();

  const upsert = (name: string, optional: boolean, extraConfig: Record<string, unknown> = {}) => {
    if (!name) return;
    const prev = seen.get(name);
    if (prev === undefined) {
      seen.set(name, { optional, extraConfig: { ...extraConfig } });
    } else {
      seen.set(name, {
        optional: prev.optional && optional,
        extraConfig: { ...prev.extraConfig, ...extraConfig },
      });
    }
  };

  if (Array.isArray(rawBags)) {
    for (const item of rawBags) {
      if (typeof item === "string") {
        const opt = makeNonBaseOptional && !BASE_IDENTITY_BAGS.has(item);
        upsert(item, opt);
      } else if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        if (typeof obj.name === "string") {
          const { name, optional, ...rest } = obj;
          const opt = optional === true || (makeNonBaseOptional && !BASE_IDENTITY_BAGS.has(name));
          upsert(name, opt, rest);
        } else {
          for (const [k, v] of Object.entries(obj)) {
            const vObj = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
            const { extensions, optional, ...restConfig } = vObj;
            const explicitOpt = optional === true;
            const opt = explicitOpt || (makeNonBaseOptional && !BASE_IDENTITY_BAGS.has(k));
            upsert(k, opt, restConfig);
            if (Array.isArray(extensions)) {
              for (const ext of extensions) {
                if (typeof ext === "string") {
                  const extBagName = k === "sessions" && ext === "search" ? "session-vector-search" : `${k}-${ext}`;
                  const extOpt = explicitOpt || (makeNonBaseOptional && !BASE_IDENTITY_BAGS.has(extBagName));
                  upsert(extBagName, extOpt);
                }
              }
            }
          }
        }
      }
    }
  }

  return [...seen.entries()].map(([name, info]) => ({
    name,
    optional: info.optional,
    extraConfig: info.extraConfig,
  }));
}

export function migrateIdentityYamlObject(
  doc: Record<string, unknown>,
  options: {
    identityName: string;
    traitsTableMap?: ReadonlyMap<string, TraitRowSummary>;
    installedBagNames?: ReadonlySet<string>;
    customBoundsToAdd?: ReadonlyArray<{ name: string; description?: string | null; bound: Record<string, unknown> }>;
  },
): { updated: Record<string, unknown>; changes: string[] } {
  const updated: Record<string, unknown> = { ...doc };
  const changes: string[] = [];
  const traitsMap = options.traitsTableMap ?? new Map<string, TraitRowSummary>();

  const legacyGrantKey = ["bag", "grant"].join("_");
  const hasTraits = Object.hasOwn(updated, "traits");
  const hasBagGrant = Object.hasOwn(updated, legacyGrantKey);
  const bagGrantSession = updated[legacyGrantKey] === "session";

  const hasNestedBagExtensions =
    Array.isArray(updated.bags) &&
    updated.bags.some(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        !("name" in entry) &&
        Object.values(entry as Record<string, unknown>).some(
          (v) => v && typeof v === "object" && Array.isArray((v as { extensions?: unknown }).extensions),
        ),
    );

  const boundsToAppend: unknown[] = [];

  if (hasTraits || hasBagGrant || hasNestedBagExtensions) {
    const normalizedBags = normalizeBagEntryList(updated.bags ?? [], bagGrantSession);
    const bagMap = new Map<string, { optional: boolean; extraConfig: Record<string, unknown> }>();
    for (const entry of normalizedBags) {
      bagMap.set(entry.name, { optional: entry.optional, extraConfig: entry.extraConfig });
    }

    if (Array.isArray(updated.traits)) {
      const requiredTraitNames: string[] = [];
      const optionalTraitNames: string[] = [];
      for (const item of updated.traits) {
        if (typeof item === "string") {
          requiredTraitNames.push(item);
        } else if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>;
          if (typeof obj.name === "string") {
            if (obj.optional === true) optionalTraitNames.push(obj.name);
            else requiredTraitNames.push(obj.name);
          } else {
            for (const [k, v] of Object.entries(obj)) {
              const isOpt = v && typeof v === "object" && (v as { optional?: unknown }).optional === true;
              if (isOpt) optionalTraitNames.push(k);
              else requiredTraitNames.push(k);
            }
          }
        }
      }

      const reqExpanded = expandTraitSelection(requiredTraitNames, traitsMap, options.installedBagNames);
      const optExpanded = expandTraitSelection(optionalTraitNames, traitsMap, options.installedBagNames);

      for (const b of reqExpanded.bags) {
        const existing = bagMap.get(b);
        if (!existing) {
          bagMap.set(b, { optional: false, extraConfig: {} });
        } else if (existing.optional) {
          // Explicitly listed in required `traits:` means active by default in sessions
          bagMap.set(b, { optional: false, extraConfig: existing.extraConfig });
        }
      }
      for (const b of optExpanded.bags) {
        if (!bagMap.has(b)) {
          bagMap.set(b, { optional: true, extraConfig: {} });
        }
      }
      for (const synth of [...reqExpanded.synthesizedBounds, ...optExpanded.synthesizedBounds]) {
        boundsToAppend.push({ [synth.name]: synth.bound });
      }
      for (const bName of reqExpanded.bounds) {
        boundsToAppend.push(bName);
      }
      for (const bName of optExpanded.bounds) {
        boundsToAppend.push({ [bName]: { optional: true } });
      }
    }

    const finalBags: Array<string | Record<string, unknown>> = [];
    for (const [name, info] of bagMap.entries()) {
      const cfg: Record<string, unknown> = {
        ...(info.optional ? { optional: true } : {}),
        ...info.extraConfig,
      };
      if (Object.keys(cfg).length > 0) {
        finalBags.push({ [name]: cfg });
      } else {
        finalBags.push(name);
      }
    }
    if (finalBags.length > 0 || Array.isArray(updated.bags)) {
      updated.bags = finalBags;
    }

    if (hasTraits) {
      delete updated.traits;
      changes.push("converted traits: to bags:/bounds:");
    }
    if (hasBagGrant) {
      delete updated[legacyGrantKey];
      changes.push(`removed ${legacyGrantKey}:`);
    }
    if (hasNestedBagExtensions) {
      changes.push("flattened nested extensions: in bags:");
    }
  }

  const rawInlineBound = updated.bound ?? updated.scope;
  if (
    (Object.hasOwn(updated, "bound") || Object.hasOwn(updated, "scope")) &&
    rawInlineBound &&
    typeof rawInlineBound === "object"
  ) {
    const converted = convertLegacyBound(rawInlineBound as Record<string, unknown>);
    boundsToAppend.unshift({
      [options.identityName]: {
        description: `${options.identityName}'s own restrictions, moved from bound:`,
        ...converted,
      },
    });
    delete updated.bound;
    delete updated.scope;
    changes.push(`moved inline bound: into bounds: (${options.identityName})`);
  }

  const existingBounds = Array.isArray(updated.bounds) ? [...updated.bounds] : [];
  let convertedExistingBound = false;
  const normalizedBounds = existingBounds.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const obj = entry as Record<string, unknown>;
    if (typeof obj.name === "string" && hasLegacyBoundKeys(obj)) {
      convertedExistingBound = true;
      const { name, optional, ...rest } = obj;
      const converted = convertLegacyBound(rest);
      return {
        [name]: {
          description:
            typeof converted.description === "string" ? converted.description : `Bound '${name}'`,
          ...converted,
          ...(optional === true ? { optional: true } : {}),
        },
      };
    }
    const keys = Object.keys(obj);
    if (keys.length === 1) {
      const key = keys[0];
      const val = obj[key];
      if (val && typeof val === "object" && !Array.isArray(val) && hasLegacyBoundKeys(val)) {
        convertedExistingBound = true;
        const converted = convertLegacyBound(val as Record<string, unknown>);
        return {
          [key]: {
            description:
              typeof converted.description === "string" ? converted.description : `Bound '${key}'`,
            ...converted,
          },
        };
      }
    }
    return entry;
  });

  if (convertedExistingBound) {
    changes.push("converted legacy inline bounds: to { allow, deny }");
  }

  const existingBoundNames = new Set<string>();
  for (const entry of normalizedBounds) {
    if (typeof entry === "string") existingBoundNames.add(entry);
    else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const obj = entry as Record<string, unknown>;
      if (typeof obj.name === "string") existingBoundNames.add(obj.name);
      else {
        const k = Object.keys(obj)[0];
        if (k) existingBoundNames.add(k);
      }
    }
  }

  for (const item of boundsToAppend) {
    const itemName =
      typeof item === "string"
        ? item
        : item && typeof item === "object"
          ? Object.keys(item as Record<string, unknown>)[0]
          : undefined;
    if (itemName && !existingBoundNames.has(itemName)) {
      existingBoundNames.add(itemName);
      normalizedBounds.push(item);
    }
  }

  if (options.customBoundsToAdd?.length) {
    for (const custom of options.customBoundsToAdd) {
      if (existingBoundNames.has(custom.name)) continue;
      existingBoundNames.add(custom.name);
      const converted = convertLegacyBound(custom.bound);
      normalizedBounds.push({
        [custom.name]: {
          description:
            custom.description ||
            (typeof converted.description === "string"
              ? converted.description
              : `Custom bound '${custom.name}' migrated from identities.db`),
          ...converted,
          optional: true,
        },
      });
      changes.push(`copied custom DB bound '${custom.name}' to bounds:`);
    }
  }

  if (normalizedBounds.length > 0 || Array.isArray(updated.bounds)) {
    updated.bounds = normalizedBounds;
  }

  return { updated, changes };
}

export function migrateBagManifestObject(
  doc: Record<string, unknown>,
  bagName: string,
): { updated: Record<string, unknown>; changes: string[] } {
  const updated: Record<string, unknown> = { ...doc };
  const changes: string[] = [];

  const boundsMap: Record<string, unknown> =
    updated.bounds && typeof updated.bounds === "object" && !Array.isArray(updated.bounds)
      ? { ...(updated.bounds as Record<string, unknown>) }
      : {};
  let boundsChanged = false;

  if (Object.hasOwn(updated, "traits")) {
    const rawTraits = updated.traits;
    if (rawTraits && typeof rawTraits === "object" && !Array.isArray(rawTraits)) {
      for (const [traitKey, traitVal] of Object.entries(rawTraits as Record<string, unknown>)) {
        if (!traitVal || typeof traitVal !== "object" || Array.isArray(traitVal)) continue;
        const tObj = traitVal as Record<string, unknown>;
        if (tObj.bound && typeof tObj.bound === "object") {
          const shortName = traitKey.startsWith(`${bagName}:`)
            ? traitKey.slice(bagName.length + 1)
            : traitKey;
          if (!Object.hasOwn(boundsMap, shortName) && !Object.hasOwn(boundsMap, traitKey)) {
            const converted = convertLegacyBound({
              ...(typeof tObj.description === "string" ? { description: tObj.description } : {}),
              ...(tObj.bound as Record<string, unknown>),
            });
            boundsMap[shortName] = converted;
            boundsChanged = true;
          }
        }
      }
    }
    delete updated.traits;
    changes.push("removed traits: from bag.yaml");
  }

  for (const [bKey, bVal] of Object.entries(boundsMap)) {
    if (
      bVal &&
      typeof bVal === "object" &&
      !Array.isArray(bVal) &&
      hasLegacyBoundKeys(bVal, { allowNestedBoundWrapper: true })
    ) {
      boundsMap[bKey] = convertLegacyBound(bVal as Record<string, unknown>);
      boundsChanged = true;
    }
  }
  if (boundsChanged) {
    updated.bounds = boundsMap;
    changes.push("converted bounds: to { allow, deny }");
  }

  if (updated.jobs && typeof updated.jobs === "object" && !Array.isArray(updated.jobs)) {
    const jobsMap = { ...(updated.jobs as Record<string, unknown>) };
    let jobsChanged = false;
    for (const [jobKey, jobVal] of Object.entries(jobsMap)) {
      if (!jobVal || typeof jobVal !== "object" || Array.isArray(jobVal)) continue;
      const jObj = { ...(jobVal as Record<string, unknown>) };
      if (Array.isArray(jObj.traits)) {
        const expanded = expandTraitSelection(
          jObj.traits.filter((t): t is string => typeof t === "string"),
          new Map(),
        );
        delete jObj.traits;
        if (expanded.bounds.length > 0) {
          const existingJobBounds = Array.isArray(jObj.bounds) ? jObj.bounds : [];
          jObj.bounds = [...new Set([...existingJobBounds, ...expanded.bounds])];
        }
        jobsMap[jobKey] = jObj;
        jobsChanged = true;
      }
    }
    if (jobsChanged) {
      updated.jobs = jobsMap;
      changes.push("converted jobs.*.traits to bounds:");
    }
  }

  if (updated.schedules && typeof updated.schedules === "object" && !Array.isArray(updated.schedules)) {
    const schedulesMap = { ...(updated.schedules as Record<string, unknown>) };
    let schedulesChanged = false;
    for (const [schedKey, schedVal] of Object.entries(schedulesMap)) {
      if (!schedVal || typeof schedVal !== "object" || Array.isArray(schedVal)) continue;
      const sObj = { ...(schedVal as Record<string, unknown>) };
      if (Array.isArray(sObj.traits)) {
        const expanded = expandTraitSelection(
          sObj.traits.filter((t): t is string => typeof t === "string"),
          new Map(),
        );
        delete sObj.traits;
        if (expanded.bags.length > 0 && !sObj.bags) {
          sObj.bags = expanded.bags;
        }
        if (expanded.bounds.length > 0) {
          const existingSchedBounds = Array.isArray(sObj.bounds) ? sObj.bounds : [];
          sObj.bounds = [...new Set([...existingSchedBounds, ...expanded.bounds])];
        }
        schedulesMap[schedKey] = sObj;
        schedulesChanged = true;
      }
    }
    if (schedulesChanged) {
      updated.schedules = schedulesMap;
      changes.push("converted schedules.*.traits to bags:/bounds:");
    }
  }

  if (typeof updated.extends === "string" && updated.extends.length > 0) {
    if (!Object.hasOwn(updated, "implements")) {
      updated.implements = updated.extends;
    }
    delete updated.extends;
    changes.push("renamed extends: to implements:");
  }

  return { updated, changes };
}

let activeBackupDir: string | null = null;
const backedUpFiles = new Set<string>();

/**
 * Create a timestamped backup directory under `<barryBackupsDir()>/pre-no-traits-<ts>/`
 * and copy `filePath` into it before mutating `filePath`.
 */
export function backupBeforeDoctorWrite(filePath: string, label?: string): string | null {
  if (!existsSync(filePath)) return null;
  const currentBackupsRoot = barryBackupsDir();
  if (!activeBackupDir || !activeBackupDir.startsWith(currentBackupsRoot)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    activeBackupDir = join(currentBackupsRoot, `pre-no-traits-${stamp}`);
    backedUpFiles.clear();
    mkdirSync(activeBackupDir, { recursive: true });
  }
  if (!backedUpFiles.has(filePath)) {
    backedUpFiles.add(filePath);
    const safeRel = (label ?? basename(filePath)).replace(/[^a-zA-Z0-9._/-]/g, "_");
    const target = join(activeBackupDir, safeRel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(filePath, target);
  }
  return activeBackupDir;
}

export function writeTextAtomicWithBackup(filePath: string, content: string, backupLabel?: string): void {
  backupBeforeDoctorWrite(filePath, backupLabel);
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, content, "utf8");
  renameSync(tmpPath, filePath);
}

export interface LegacyDbBoundRow {
  id: number;
  name: string;
  description: string | null;
  bound: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

/**
 * Inspect `identities.db` directly via `BetterSqlite3`, guarding queries with
 * `sqlite_master` table-existence checks so `doctor` works both before and
 * after Stage 8 drops `traits` and `bounds`.
 */
export async function readLegacyIdentitiesSqlite(dbPath: string): Promise<{
  hasBoundsTable: boolean;
  hasTraitsTable: boolean;
  allBounds: LegacyDbBoundRow[];
  customBounds: LegacyDbBoundRow[];
  traitsByName: Map<string, TraitRowSummary>;
}> {
  const result = {
    hasBoundsTable: false,
    hasTraitsTable: false,
    allBounds: [] as LegacyDbBoundRow[],
    customBounds: [] as LegacyDbBoundRow[],
    traitsByName: new Map<string, TraitRowSummary>(),
  };
  if (!existsSync(dbPath)) return result;

  const { default: BetterSqlite3 } = await import("better-sqlite3");
  const db = new BetterSqlite3(dbPath);
  try {
    const hasTable = (name: string): boolean => {
      const row = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(name);
      return Boolean(row);
    };

    if (hasTable("bounds")) {
      result.hasBoundsTable = true;
      const rows = db
        .prepare("SELECT id, name, description, bound, metadata FROM bounds")
        .all() as Array<{
        id: number;
        name: string;
        description: string | null;
        bound: string;
        metadata: string;
      }>;
      const customRows = db
        .prepare(
          "SELECT id, name, description, bound, metadata FROM bounds WHERE json_extract(metadata, '$.bag') IS NULL",
        )
        .all() as Array<{
        id: number;
        name: string;
        description: string | null;
        bound: string;
        metadata: string;
      }>;

      const parseRow = (r: {
        id: number;
        name: string;
        description: string | null;
        bound: string;
        metadata: string;
      }): LegacyDbBoundRow => {
        let parsedBound: Record<string, unknown> = {};
        let parsedMeta: Record<string, unknown> = {};
        try {
          parsedBound = JSON.parse(r.bound || "{}") as Record<string, unknown>;
        } catch {
          parsedBound = {};
        }
        try {
          parsedMeta = JSON.parse(r.metadata || "{}") as Record<string, unknown>;
        } catch {
          parsedMeta = {};
        }
        return {
          id: r.id,
          name: r.name,
          description: r.description,
          bound: parsedBound,
          metadata: parsedMeta,
        };
      };

      result.allBounds = rows.map(parseRow);
      result.customBounds = customRows
        .map(parseRow)
        .filter((r) => !HISTORICAL_SHIPPED_BOUND_NAMES.has(r.name) && !r.name.startsWith("builtin:"));
    }

    if (hasTable("traits")) {
      result.hasTraitsTable = true;
      const rows = db
        .prepare("SELECT name, access, namespaces, bound, metadata, bag FROM traits")
        .all() as Array<{
        name: string;
        access: string;
        namespaces: string;
        bound: string;
        metadata: string;
        bag: string | null;
      }>;
      for (const r of rows) {
        let namespaces: string[] = [];
        let bound: Record<string, unknown> | null = null;
        let boundNames: string[] = [];
        try {
          const parsedNs = JSON.parse(r.namespaces || "[]");
          if (Array.isArray(parsedNs)) {
            namespaces = parsedNs.filter((s): s is string => typeof s === "string");
          }
        } catch {
          namespaces = [];
        }
        try {
          const parsedBound = JSON.parse(r.bound || "{}");
          if (
            parsedBound &&
            typeof parsedBound === "object" &&
            !Array.isArray(parsedBound) &&
            Object.keys(parsedBound).length > 0
          ) {
            bound = parsedBound as Record<string, unknown>;
          }
        } catch {
          bound = null;
        }
        try {
          const parsedMeta = JSON.parse(r.metadata || "{}") as {
            boundNames?: unknown;
            bounds?: unknown;
          };
          const rawNames = parsedMeta.boundNames ?? parsedMeta.bounds;
          if (Array.isArray(rawNames)) {
            boundNames = rawNames.filter((s): s is string => typeof s === "string");
          }
        } catch {
          boundNames = [];
        }
        result.traitsByName.set(r.name, {
          name: r.name,
          access: r.access,
          namespaces,
          boundNames,
          bound,
          bag: r.bag,
        });
      }
    }
  } finally {
    db.close();
  }

  return result;
}
