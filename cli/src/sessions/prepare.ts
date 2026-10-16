import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import type { StartOptions } from "../commands/start.js";
import type { PreCreateSessionInput, PreCreateResult } from "./launch-context.js";
import type { InstalledAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import type { ModeId } from "@barry-rocks/sdk/ids";
import { generateId } from "@barry-rocks/sdk/ids";
import { begin, span } from "../lib/timing.js";
import { CliError } from "../lib/cli-error.js";
import { ApiRequestError } from "./api-request.js";

let createBagsSupported: boolean | undefined;
/** Older shipped contracts require POST followed by PATCH for bags. */
export function supportsCreateBags(): boolean {
  if (createBagsSupported !== undefined) return createBagsSupported;
  try {
    const require = createRequire(import.meta.url);
    const spec = JSON.parse(readFileSync(require.resolve("@barry-rocks/sdk/openapi.json"), "utf8")) as {
      components?: { schemas?: { NativeSessionRequest?: { properties?: Record<string, unknown> } } };
    };
    const props = spec.components?.schemas?.NativeSessionRequest?.properties ?? {};
    return (createBagsSupported = Object.hasOwn(props, "bags"));
  } catch {
    return (createBagsSupported = false);
  }
}

/** Parse comma-separated `--bag` / `--bags` tokens, splitting `<bag>:read` shorthands into bag + bound. */
export function parseBagFlagTokens(raw: string | undefined): { bags: string[]; readBounds: string[] } {
  if (!raw) return { bags: [], readBounds: [] };
  const bags: string[] = [];
  const readBounds: string[] = [];
  for (const token of raw.split(",").map((t) => t.trim()).filter(Boolean)) {
    if (token.endsWith(":read") && token.length > ":read".length) {
      const bagName = token.slice(0, -":read".length);
      if (!bags.includes(bagName)) bags.push(bagName);
      if (!readBounds.includes(token)) readBounds.push(token);
    } else if (!bags.includes(token)) {
      bags.push(token);
    }
  }
  return { bags, readBounds };
}

export interface SessionHeader {
  identity?: string;
  bags?: string;
  bounds?: string;
  identityBounds?: string;
  sessionId: string;
}

export type SelectionSource = "picker" | "flag" | "all" | "none" | "resume" | "last" | "read";

export interface SessionPreparation {
  sessionId: string;
  identityId: number;
  identityName: string;
  identityBagNames: string[];
  selectedBounds: string[];
  directive: string | null;
  sessionBags: string[];
  selectionSource: SelectionSource;
  model?: string;
  modelProvider?: string;
  interactive: boolean;
  sessionName?: string;
  header: SessionHeader;
  claudeArgs: string[];
  tmpDirs: string[];
}

export interface PreparationDependencies {
  checkKnownCommand: (arg: string) => void;
  expandComposition: (names: string[]) => Promise<string[]>;
  baseBags: () => string[];
  isBuiltinBag?: (name: string) => boolean;
  allBags: (names: string[]) => Promise<string[]>;
  pick: (
    names: string[],
    previous: { bags?: string[]; bounds?: string[] } | undefined,
    showBuiltin: boolean | undefined,
    header: SessionHeader,
    identityId: number,
  ) => Promise<{ bags: string[]; bounds?: string[] }>;
  directive: () => Promise<string | null>;
  recallSelection?: () => { bags: string[]; bounds: string[] };
  rememberSelection?: (selection: { bags: string[]; bounds?: string[] }) => boolean;
  model: () => Promise<{ model?: string; modelProvider?: string }>;
  supportsBags?: boolean;
  persistSelection?: (id: string, selection: { bags: string[]; bounds?: string[] }) => Promise<void>;
  create: (input: PreCreateSessionInput) => Promise<PreCreateResult>;
  printHeader: (header: SessionHeader) => void;
  warn: (message: string) => void;
  cancelled: (error: unknown) => boolean;
  abandon: (id: string) => Promise<never>;
}

/** One selection rule for hosted and vendor UI launches. Explicit flags win on resume. */
export async function selectSessionCapabilities(
  options: StartOptions,
  names: string[],
  header: SessionHeader,
  identityId: number,
  deps: Pick<
    PreparationDependencies,
    "allBags" | "pick" | "cancelled" | "abandon" | "warn" | "printHeader" | "recallSelection"
  >,
): Promise<{ sessionBags: string[]; extraBounds: string[]; selectionSource: SelectionSource }> {
  const rawBags = options.bag ?? options.bags;
  const parsedFlag = parseBagFlagTokens(rawBags);

  if (options._resumeBags && (rawBags || options.all || options.none)) {
    if (rawBags) {
      return {
        sessionBags: parsedFlag.bags,
        extraBounds: parsedFlag.readBounds,
        selectionSource: "flag",
      };
    }
    if (options.all) {
      return {
        sessionBags: await deps.allBags(names),
        extraBounds: [],
        selectionSource: options.read ? "read" : "all",
      };
    }
    return { sessionBags: [], extraBounds: [], selectionSource: "none" };
  }

  if (!options._resumeBags) {
    if (options.none) return { sessionBags: [], extraBounds: [], selectionSource: "none" };
    if (options.all) {
      return {
        sessionBags: await deps.allBags(names),
        extraBounds: [],
        selectionSource: options.read ? "read" : "all",
      };
    }
    if (rawBags) {
      return {
        sessionBags: parsedFlag.bags,
        extraBounds: parsedFlag.readBounds,
        selectionSource: "flag",
      };
    }
  }

  const remembered = deps.recallSelection?.() ?? { bags: [], bounds: [] };
  const hasRemembered = remembered.bags.length > 0 || remembered.bounds.length > 0;
  const useLast = options.last || (!options._resumeBags && process.env.BARRY_BAGS === "last");
  if (useLast && hasRemembered) {
    return {
      sessionBags: remembered.bags,
      extraBounds: remembered.bounds,
      selectionSource: "last",
    };
  }
  if (useLast) {
    deps.warn("No remembered selection for this identity and harness; opening the picker.");
  }
  if (!options._resumeBags && !useLast && (options.prompt || options.transport === "stdio")) {
    return { sessionBags: [], extraBounds: [], selectionSource: "none" };
  }

  const previous =
    options._resumeBags !== undefined
      ? { bags: options._resumeBags, bounds: options._resumeBounds }
      : hasRemembered
        ? { bags: remembered.bags, bounds: remembered.bounds }
        : undefined;

  try {
    const picked = await deps.pick(names, previous, options.showBuiltin, header, identityId);
    return {
      sessionBags: picked.bags,
      extraBounds: picked.bounds ?? [],
      selectionSource: "picker",
    };
  } catch (error) {
    if (deps.cancelled(error)) return deps.abandon(header.sessionId);
    deps.warn(`Warning: capability picker failed — ${error instanceof Error ? error.message : error}`);
    deps.printHeader(header);
    return {
      sessionBags: options._resumeBags ?? [],
      extraBounds: [],
      selectionSource: options._resumeBags ? "resume" : "none",
    };
  }
}

/** Only shared session data: no secrets, harness config, adapter code or temporary files. */
export async function prepareSession(
  args: string[],
  options: StartOptions,
  identity: {
    id: number;
    name: string;
    bags: string[];
    configuration?: { bounds: Array<{ name: string; optional?: boolean }> };
  },
  harness: InstalledAdapter,
  mode: ModeId,
  deps: PreparationDependencies,
): Promise<SessionPreparation> {
  if (args.length) deps.checkKnownCommand(args[0]);
  const rawBounds = options.bound ?? options.bounds;
  if (options.read) {
    options.bound = [
      ...new Set([...(rawBounds?.split(",").map((n) => n.trim()).filter(Boolean) ?? []), "readonly"]),
    ].join(",");
    options.all = true;
  }
  const names = [...identity.bags];
  for (const name of deps.baseBags()) if (!names.includes(name)) names.unshift(name);
  const identityBagNames = await span("session:composition", () => deps.expandComposition(names));
  const directive =
    typeof options.directive === "string"
      ? options.directive
      : options.directive === true
        ? await deps.directive()
        : null;
  const parsedBagFlag = parseBagFlagTokens(options.bag ?? options.bags);
  const explicitBounds = [
    ...new Set([
      ...(options._resumeBounds ?? []),
      ...((options.bound ?? options.bounds)?.split(",").map((n) => n.trim()).filter(Boolean) ?? []),
      ...parsedBagFlag.readBounds,
    ]),
  ];
  const sessionId = options._resumeSessionId ?? generateId();
  const visibleBags = options.showBuiltin
    ? identityBagNames
    : identityBagNames.filter((name) => !deps.isBuiltinBag?.(name));
  const hidden = identityBagNames.length - visibleBags.length;
  const bagSummary = [
    visibleBags.join(", "),
    hidden ? `${hidden} builtin hidden — --show-builtin to show` : "",
  ]
    .filter(Boolean)
    .join("; ");
  const header: SessionHeader = {
    identity: identity.name,
    sessionId,
    bags: bagSummary,
    bounds: explicitBounds.length ? explicitBounds.join(", ") : "none",
    identityBounds: identity.configuration?.bounds
      .filter((bound) => !bound.optional)
      .map((bound) => bound.name)
      .join(", "),
  };
  const remembered = deps.recallSelection?.() ?? { bags: [], bounds: [] };
  const hasRemembered = remembered.bags.length > 0 || remembered.bounds.length > 0;
  const useLast = options.last || (!options._resumeBags && process.env.BARRY_BAGS === "last");
  const explicit = Boolean(options.bag || options.bags || options.all || options.none);
  const interactivePicker =
    !explicit &&
    !(useLast && hasRemembered) &&
    Boolean(options._resumeBags || useLast || (!options.prompt && options.transport !== "stdio"));
  if (!interactivePicker) deps.printHeader(header);
  const finishSelection = begin("session:selection", interactivePicker);
  const selection = await selectSessionCapabilities(options, identityBagNames, header, identity.id, {
    ...deps,
    recallSelection: () => remembered,
  });
  finishSelection();
  const selectedBounds = [...new Set([...explicitBounds, ...selection.extraBounds])];
  if (selectedBounds.length) {
    header.bounds = selectedBounds.join(", ");
  }
  if (
    (selection.sessionBags.length > 0 || selection.extraBounds.length > 0) &&
    ["picker", "flag"].includes(selection.selectionSource) &&
    deps.rememberSelection?.({ bags: selection.sessionBags, bounds: selectedBounds }) === false
  ) {
    deps.warn(
      "Could not remember this session selection; another command may be saving preferences; retry, or check this instance's config directory permissions.",
    );
  }
  const model = await deps.model();
  const createInput: PreCreateSessionInput = {
    sessionId,
    cwd: process.cwd(),
    source: ["cursor", "codex", "opencode"].includes(harness.id) ? harness.id : "cli",
    identityId: identity.id,
    selectedBounds,
    harness: harness.aliases?.[0] ?? harness.id,
    status: "pending",
    ...(options._resumeSessionId ? {} : { directive }),
    name: options.sessionName,
    ...(deps.supportsBags === false ? {} : { bags: selection.sessionBags }),
    ...model,
    mode,
  };
  const required = mode === "hosted" || selectedBounds.length > 0;
  const result = await span("session:precreate", async () => {
    try {
      return await deps.create(createInput);
    } catch (error) {
      if (required || (error instanceof CliError && !(error instanceof ApiRequestError))) throw error;
      return { ok: false, body: {}, warning: error instanceof Error ? error.message : String(error) };
    }
  });
  if (!result.ok) {
    if (required) throw new Error(result.warning ?? "Could not create session");
    deps.warn(`Warning: ${result.warning ?? "Could not create session"}; continuing without API recording.`);
  }
  if (result.ok && deps.supportsBags === false) {
    if (!deps.persistSelection) throw new Error("Session API requires a separate selection update");
    await span("session:selection-persisted", () =>
      deps.persistSelection!(sessionId, { bags: selection.sessionBags, bounds: selectedBounds }),
    );
  }
  return {
    sessionId,
    identityId: identity.id,
    identityName: identity.name,
    identityBagNames,
    selectedBounds,
    directive,
    sessionBags: selection.sessionBags,
    selectionSource: selection.selectionSource,
    ...model,
    interactive: !options.prompt,
    sessionName: options.sessionName,
    header,
    claudeArgs: args,
    tmpDirs: [],
  };
}
