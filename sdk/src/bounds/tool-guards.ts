import { checkBashBound } from "./bash-classifier.js";
import {
  checkNetworkBound,
  isDomainDenied,
  extractDomainsFromCommand,
  expandActions,
  parseNetworkRule,
  matchesUrlPattern,
  getImpliedDeniedTools,
  NETWORK_TOOL_ACTIONS,
  NETWORK_TOOL_URL_PARAMS,
  type ParsedNetworkRule,
} from "./network-classifier.js";
import type { ToolContext } from "../tools/define-tool.js";
import type { AllowDeny, Bound } from "./types.js";
import {
  isBashDenied,
  isFileDenied,
  isFileAllowed,
  canonicalFilePath,
  isFileSearchDenied,
} from "./bound-guards.js";
import { isConfigWriteBlocked } from "./config-protection.js";
import { classifyFileWrite } from "./file-write-classifier.js";

export interface BoundGuardTool {
  id?: string;
  namespace?: string;
  name: string;
  access?: "read" | "write";
  schema?: Readonly<Record<string, unknown>>;
  handler: (params: Record<string, unknown>, context: ToolContext) => Promise<unknown>;
}

const nativePathParams: Record<string, string> = {
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  Glob: "path",
  Grep: "path",
  LS: "path",
};

const FILE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

/** First-party definitions expose their path fields; native tools use legacy names. */
export function filePathParameters(tool: Pick<BoundGuardTool, "name" | "schema">): string[] {
  const declared = Object.keys(tool.schema ?? {}).filter((key) => /path$/i.test(key));
  const legacy = nativePathParams[tool.name] ?? (tool.name === "open" ? "path" : undefined);
  return [...new Set([...declared, ...(legacy ? [legacy] : [])])];
}

function matchesInputPattern(value: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*") && !pattern.includes("?")) return value === pattern;
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "s").test(value);
}

function toScalarStrings(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    return [String(raw)];
  }
  if (Array.isArray(raw)) {
    const out: string[] = [];
    for (const item of raw) {
      if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
        return null;
      }
      out.push(String(item));
    }
    return out;
  }
  return null;
}

/**
 * Validate tool call parameters against `bound.inputs[toolId]`.
 * Throws an `Access denied` error when a parameter violates its `{ allow, deny }` rule.
 */
export function assertInputsAllowed(
  toolId: string,
  params: Record<string, unknown>,
  paramRules: Readonly<Record<string, AllowDeny>>,
): void {
  for (const [paramName, rule] of Object.entries(paramRules)) {
    const raw = params[paramName];
    const values = toScalarStrings(raw);

    if (rule.deny?.length && values !== null) {
      for (const val of values) {
        const denied = rule.deny.find((pattern) => matchesInputPattern(val, pattern));
        if (denied !== undefined) {
          throw new Error(
            `Access denied: parameter '${paramName}' on '${toolId}' matches deny pattern '${denied}'.`,
          );
        }
      }
    }

    const allowClauses =
      rule.allowClauses ?? (rule.allow !== undefined ? [rule.allow] : undefined);
    if (allowClauses !== undefined) {
      if (values === null || values.length === 0) {
        throw new Error(
          `Access denied: parameter '${paramName}' is required on '${toolId}' by this session's input bound.`,
        );
      }
      for (const val of values) {
        for (const clause of allowClauses) {
          if (!clause.some((pattern) => matchesInputPattern(val, pattern))) {
            throw new Error(
              `Access denied: parameter '${paramName}' value '${val}' on '${toolId}' is not permitted by this session's input bound.`,
            );
          }
        }
      }
    }
  }
}

/**
 * When `bound.inputs[toolId][param].allow` reduces a parameter to a fixed set
 * of literal strings (no wildcards), narrow its JSON Schema property to
 * `enum: [...]` so the model sees the exact allowed values before calling.
 */
export function narrowJsonSchemaWithInputs(
  jsonSchema: Record<string, unknown>,
  paramRules: Readonly<Record<string, AllowDeny>> | undefined,
): Record<string, unknown> {
  if (!paramRules || Object.keys(paramRules).length === 0) return jsonSchema;
  const properties = jsonSchema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties || typeof properties !== "object") return jsonSchema;

  let changed = false;
  const nextProps: Record<string, Record<string, unknown>> = { ...properties };
  const requiredSet = new Set<string>(
    Array.isArray(jsonSchema.required) ? (jsonSchema.required as string[]) : [],
  );

  for (const [paramName, rule] of Object.entries(paramRules)) {
    const prop = nextProps[paramName];
    if (!prop || typeof prop !== "object") continue;

    const allowClauses =
      rule.allowClauses ?? (rule.allow !== undefined ? [rule.allow] : undefined);
    if (!allowClauses || allowClauses.length === 0) continue;

    // Only narrow to `enum` when every clause consists solely of literal strings (no `*`, `?`, `[`, `{`).
    const allLiteral = allowClauses.every((clause) =>
      clause.every(
        (pattern) =>
          !pattern.includes("*") &&
          !pattern.includes("?") &&
          !pattern.includes("[") &&
          !pattern.includes("{"),
      ),
    );
    if (!allLiteral) continue;

    let candidates = [...new Set(allowClauses[0])];
    for (let i = 1; i < allowClauses.length; i++) {
      const set = new Set(allowClauses[i]);
      candidates = candidates.filter((c) => set.has(c));
    }
    if (rule.deny?.length) {
      candidates = candidates.filter(
        (c) => !rule.deny!.some((pattern) => matchesInputPattern(c, pattern)),
      );
    }

    nextProps[paramName] = {
      ...prop,
      enum: candidates,
      ...(candidates.length === 1 ? { const: candidates[0] } : {}),
    };
    requiredSet.add(paramName);
    changed = true;
  }

  if (!changed) return jsonSchema;
  return {
    ...jsonSchema,
    properties: nextProps,
    required: [...requiredSet],
  };
}

/**
 * Narrow an MCP tool's JSON Schema `properties` and `required` using `bound.inputs`
 * for `qualifiedToolId` (`<namespace>:<name>`).
 */
export function narrowInputSchemaForBound(
  jsonSchema: Record<string, unknown>,
  qualifiedToolId: string,
  bound?: Bound | null,
): Record<string, unknown> {
  if (!bound?.inputs) return jsonSchema;
  const colonIdx = qualifiedToolId.indexOf(":");
  const bareName = colonIdx !== -1 ? qualifiedToolId.slice(colonIdx + 1) : qualifiedToolId;
  const paramRules = bound.inputs[qualifiedToolId] ?? bound.inputs[bareName];
  return narrowJsonSchemaWithInputs(jsonSchema, paramRules);
}

/**
 * Enforce runtime `Bound` guards (`inputs`, `files`, `bash`, `network`, `nodes`)
 * for a single tool invocation (including proxied MCP tool calls).
 */
export async function guardToolCall(
  tool: {
    id?: string;
    namespace?: string;
    name: string;
    access?: "read" | "write";
    schema?: Readonly<Record<string, unknown>>;
  },
  params: Record<string, unknown>,
  bound?: Bound | null,
  options?: { enforceConfigProtection?: boolean; nodeId?: string },
): Promise<void> {
  const nodeId = options?.nodeId;
  if (nodeId && bound?.nodes) {
    if (
      bound.nodes.deny?.includes(nodeId) ||
      (bound.nodes.allow !== undefined && !bound.nodes.allow.includes(nodeId)) ||
      (bound.nodes.allowClauses?.length &&
        !bound.nodes.allowClauses.every((clause) => clause.includes(nodeId)))
    ) {
      throw new Error(`node access denied: ${nodeId}`);
    }
  }
  if (!bound && !options?.enforceConfigProtection) return;
  const inferredSchema: Record<string, unknown> = { ...(tool.schema ?? {}) };
  for (const key of Object.keys(params)) {
    if (!(key in inferredSchema)) inferredSchema[key] = true;
  }
  const [guarded] = applyBoundGuards<BoundGuardTool>(
    [
      {
        ...tool,
        schema: inferredSchema,
        handler: async () => undefined,
      },
    ],
    bound ?? {},
    { enforceConfigProtection: options?.enforceConfigProtection ?? true },
  );
  await guarded.handler(params, {} as ToolContext);
}

export function applyBoundGuards<T extends BoundGuardTool>(
  tools: T[],
  scope: Bound,
  options?: { enforceConfigProtection?: boolean },
): T[] {
  const fileDeny = scope.files?.deny;
  const fileAllow = scope.files?.allow;
  const fileAllowClauses = scope.files?.allowClauses;
  const bashAllow = scope.bash?.allow;
  const bashAllowClauses = scope.bash?.allowClauses;
  const bashDeny = scope.bash?.deny;
  const networkAllow = scope.network?.allow;
  const networkAllowClauses = scope.network?.allowClauses;
  const networkDeny = scope.network?.deny ?? [];
  const inputsMap = scope.inputs;

  const hasFileGuards =
    !!fileDeny?.length || fileAllow !== undefined || !!fileAllowClauses?.length;
  const hasBashGuards =
    !!bashDeny?.length ||
    bashAllow !== undefined ||
    !!bashAllowClauses?.length;
  const hasNetworkGuards =
    networkDeny.length > 0 || networkAllow !== undefined || !!networkAllowClauses?.length;
  const hasInputGuards = !!inputsMap && Object.keys(inputsMap).length > 0;
  const enforceConfig = options?.enforceConfigProtection ?? false;

  if (!hasFileGuards && !hasBashGuards && !hasNetworkGuards && !hasInputGuards && !enforceConfig) {
    return tools;
  }

  const parsedNetDeny = networkDeny.map(parseNetworkRule);
  const netDenyActions = parsedNetDeny
    .filter((r): r is Extract<ParsedNetworkRule, { kind: "action" }> => r.kind === "action")
    .map((r) => r.action);
  const netDenyDomains = parsedNetDeny
    .filter((r): r is Extract<ParsedNetworkRule, { kind: "domain" }> => r.kind === "domain")
    .map((r) => r.domain);
  const netDenyUrls = parsedNetDeny.filter(
    (r): r is Extract<ParsedNetworkRule, { kind: "url" }> => r.kind === "url",
  );
  const expandedDenyActions = netDenyActions.length ? expandActions(netDenyActions) : null;

  return tools.map((tool) => {
    const qualifiedId =
      tool.id ?? (tool.namespace ? `${tool.namespace}:${tool.name}` : tool.name);
    const inputRules = inputsMap?.[qualifiedId] ?? inputsMap?.[tool.name];
    const pathParams = filePathParameters(tool);
    const isWriteFileTool = FILE_WRITE_TOOLS.has(tool.name);

    let handler = tool.handler;
    let wrapped = false;

    // 1. Input parameter guards (`bound.inputs`)
    if (inputRules && Object.keys(inputRules).length > 0) {
      const prev = handler;
      wrapped = true;
      handler = async (params, context) => {
        assertInputsAllowed(qualifiedId, params, inputRules);
        return prev(params, context);
      };
    }

    // 2. Built-in Barry config write protection & user file bounds (`bound.files`)
    if (pathParams.length && (hasFileGuards || (enforceConfig && isWriteFileTool))) {
      const prev = handler;
      wrapped = true;
      handler = async (params, context) => {
        for (const pathParam of pathParams) {
          const filePath =
            params[pathParam] ??
            (["Grep", "Glob", "LS"].includes(tool.name) ? process.cwd() : undefined);
          if (
            typeof filePath === "string" &&
            !(tool.name === "open" && /^https?:\/\//i.test(filePath))
          ) {
            if (isWriteFileTool && isConfigWriteBlocked(filePath, scope)) {
              throw new Error(
                `Access denied: writing to Barry configuration path '${filePath}' is protected.`,
              );
            }
            if (hasFileGuards) {
              let normalized: string;
              try {
                normalized = canonicalFilePath(
                  filePath,
                  fileAllow !== undefined || !!fileAllowClauses?.length,
                );
              } catch {
                throw new Error("Access denied: cannot resolve the file path under this bound");
              }
              const denyMatch = fileDeny?.length
                ? (isFileDenied(filePath, fileDeny) ?? isFileDenied(normalized, fileDeny))
                : null;
              const searchMatch =
                fileDeny?.length && ["Grep", "Glob", "LS"].includes(tool.name)
                  ? isFileSearchDenied(normalized, fileDeny)
                  : null;
              if (denyMatch || searchMatch) {
                throw new Error(
                  `Access denied: path matches deny pattern "${denyMatch ?? searchMatch}"`,
                );
              }
              if (
                (fileAllow !== undefined || fileAllowClauses?.length) &&
                !isFileAllowed(normalized, fileAllow ?? [], fileAllowClauses)
              ) {
                throw new Error(
                  "Access denied: path is outside this session's allowed paths (no match in files.allow)",
                );
              }
            }
          }
        }
        return prev(params, context);
      };
    }

    // 3. Structured network tools (`push`, `WebFetch`, `clone`, etc.)
    const toolNetActions = NETWORK_TOOL_ACTIONS[tool.name];
    if (toolNetActions && expandedDenyActions) {
      const blocked = toolNetActions.find((a) => expandedDenyActions.has(a));
      if (blocked) {
        return {
          ...tool,
          handler: async () => {
            throw new Error(
              `Access denied: '${tool.name}' is restricted by network bound — action '${blocked}' is denied in this session.`,
            );
          },
        };
      }
    }

    const urlParam =
      NETWORK_TOOL_URL_PARAMS[tool.name] ??
      (tool.schema && "url" in tool.schema ? "url" : undefined);
    if (
      urlParam &&
      (netDenyDomains.length > 0 ||
        netDenyUrls.length > 0 ||
        networkAllow !== undefined ||
        !!networkAllowClauses?.length)
    ) {
      const prev = handler;
      wrapped = true;
      handler = async (params, context) => {
        const raw = params[urlParam];
        if (typeof raw === "string") {
          for (const domain of extractDomainsFromCommand(raw)) {
            if (netDenyDomains.length > 0) {
              const match = isDomainDenied(domain, netDenyDomains);
              if (match) {
                throw new Error(
                  `Access denied: network requests to '${domain}' are restricted in this session (matches pattern '${match}').`,
                );
              }
            }
          }
          for (const rule of netDenyUrls) {
            if (matchesUrlPattern({ method: "GET", url: raw }, rule)) {
              throw new Error(
                `Access denied: HTTP request to '${raw}' is restricted in this session (matches pattern '${rule.raw}').`,
              );
            }
          }
          const allowClauses =
            networkAllowClauses ?? (networkAllow !== undefined ? [networkAllow] : undefined);
          if (allowClauses) {
            const domains = extractDomainsFromCommand(raw);
            for (const clause of allowClauses) {
              const parsedClause = clause.map(parseNetworkRule);
              const allowedActions = expandActions(
                parsedClause
                  .filter((r): r is Extract<ParsedNetworkRule, { kind: "action" }> => r.kind === "action")
                  .map((r) => r.action),
              );
              const allowedDomains = parsedClause
                .filter((r): r is Extract<ParsedNetworkRule, { kind: "domain" }> => r.kind === "domain")
                .map((r) => r.domain);
              const allowedUrls = parsedClause.filter(
                (r): r is Extract<ParsedNetworkRule, { kind: "url" }> => r.kind === "url",
              );
              const actionsForTool = NETWORK_TOOL_ACTIONS[tool.name] ?? ["http:read"];
              const actionAllowed = actionsForTool.every((a) => allowedActions.has(a));
              const domainAllowed =
                domains.length > 0 &&
                allowedDomains.length > 0 &&
                domains.every((d) => isDomainDenied(d, allowedDomains) !== null);
              const urlAllowed = allowedUrls.some((u) =>
                matchesUrlPattern({ method: "GET", url: raw }, u),
              );
              if (!actionAllowed && !domainAllowed && !urlAllowed) {
                throw new Error(
                  `Access denied: network request to '${raw}' is not in this session's network.allow list.`,
                );
              }
            }
          }
        }
        return prev(params, context);
      };
    }

    // 4. Bash command guards
    if (
      tool.name === "Bash" &&
      (hasFileGuards || hasBashGuards || hasNetworkGuards || enforceConfig)
    ) {
      const prev = handler;
      wrapped = true;
      handler = async (params, context) => {
        const command = typeof params.command === "string" ? params.command : "";
        if (hasFileGuards) {
          throw new Error(
            "Access denied: Bash is withheld by this file bound; use structured filesystem tools",
          );
        }
        if (enforceConfig) {
          const writeFinding = classifyFileWrite(command);
          if (writeFinding?.path && isConfigWriteBlocked(writeFinding.path, scope)) {
            throw new Error(
              `Access denied: writing to Barry configuration path '${writeFinding.path}' is protected.`,
            );
          }
        }
        if (bashDeny?.length || bashAllow !== undefined || bashAllowClauses?.length) {
          const bashBlocked = checkBashBound(command, scope.bash);
          if (bashBlocked) {
            if (bashBlocked === "git" || bashBlocked.startsWith("git:")) {
              throw new Error(
                `Access denied: '${bashBlocked}' is restricted to structured tools in this session — use status, diff, log, add, commit, push, and the other git_* tools instead of shelling out to git.`,
              );
            }
            if (bashDeny?.includes(bashBlocked)) {
              const subMatch = isBashDenied(command, bashDeny);
              if (subMatch) {
                throw new Error(`Access denied: command matches deny pattern "${subMatch}"`);
              }
            }
            throw new Error(
              `Access denied: command matches bash bound restriction "${bashBlocked}"`,
            );
          }
        }
        if (hasNetworkGuards) {
          const netError = checkNetworkBound(command, scope.network);
          if (netError) {
            throw new Error(netError);
          }
        }
        return prev(params, context);
      };
    }

    return wrapped ? { ...tool, handler } : tool;
  });
}

export function qualifyToolId(namespace: string, toolName: string): string {
  return `${namespace}:${toolName}`;
}

function globMatchTool(text: string, pattern: string): boolean {
  if (!pattern.includes("*")) return text === pattern;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(text);
}

/**
 * Match a single tool against a `bound.tools` pattern:
 * - `*` or `*:*` matches every tool
 * - `*:<access>` (`*:read`, `*:write`) matches all tools of that access level
 * - `*:<toolName>` matches a tool name in any namespace
 * - `<namespace>` or `<namespace>:*` matches all tools in `<namespace>`
 * - `<namespace>:<access>` (`github:read`, `github:write`) matches all tools in `<namespace>` with that access level
 * - `<namespace>:<toolName>` matches a specific tool in `<namespace>`
 * - bare `<toolName>` matches by namespace or tool name (case-insensitive)
 */
export function matchesToolPattern(
  tool: { namespace: string; toolName: string; access: "read" | "write" },
  pattern: string,
): boolean {
  const ns = tool.namespace.toLowerCase();
  const name = tool.toolName.toLowerCase();
  const access = tool.access.toLowerCase();
  const pat = pattern.toLowerCase();

  if (pat === "*" || pat === "*:*") return true;

  const colon = pat.indexOf(":");
  if (colon !== -1) {
    const patNs = pat.slice(0, colon);
    const patRhs = pat.slice(colon + 1);
    if (patNs !== "*" && !globMatchTool(ns, patNs)) return false;
    if (patRhs === "*") return true;
    if (patRhs === "read" || patRhs === "write") {
      return access === patRhs || name === patRhs;
    }
    if (patRhs === "readwrite") {
      return access === "read" || access === "write";
    }
    return globMatchTool(name, patRhs);
  }

  return globMatchTool(ns, pat) || globMatchTool(name, pat);
}

export function isToolAllowedByBound(
  tool: { namespace: string; toolName: string; access: "read" | "write"; network?: string[] },
  bound?: Bound | null,
): boolean {
  if (!bound) return true;

  const nameLower = tool.toolName.toLowerCase();
  if ((bound.files?.deny?.length || bound.files?.allow !== undefined) && nameLower === "bash") {
    return false;
  }

  if (bound.network?.deny?.length) {
    const impliedDenied = getImpliedDeniedTools(bound.network.deny);
    if (impliedDenied.some((t) => t.toLowerCase() === nameLower)) {
      return false;
    }
  }

  if (tool.network?.length && bound.network) {
    const netDeny = bound.network.deny ?? [];
    if (
      tool.network.some(
        (tag) =>
          netDeny.includes(tag) ||
          netDeny.includes("all") ||
          (tag.endsWith(":write") && netDeny.includes("write")) ||
          (tag.endsWith(":read") && netDeny.includes("read")),
      )
    ) {
      return false;
    }
    if (bound.network.allow !== undefined) {
      const clauses = bound.network.allowClauses?.length
        ? bound.network.allowClauses
        : [bound.network.allow];
      for (const clause of clauses) {
        if (
          !tool.network.every((tag) =>
            clause.some((pat) => globMatchTool(tag.toLowerCase(), pat.toLowerCase())),
          )
        ) {
          return false;
        }
      }
    }
  }

  const toolsRule = bound.tools;
  if (!toolsRule) return true;

  if (toolsRule.deny?.some((pat) => matchesToolPattern(tool, pat))) {
    return false;
  }

  if (toolsRule.allowClauses?.length) {
    for (const clause of toolsRule.allowClauses) {
      if (!clause.some((pat) => matchesToolPattern(tool, pat))) {
        return false;
      }
    }
  } else if (toolsRule.allow !== undefined) {
    if (!toolsRule.allow.some((pat) => matchesToolPattern(tool, pat))) {
      return false;
    }
  }

  return true;
}

export function filterToolObjects<
  T extends { namespace: string; name?: string; toolName?: string; access: "read" | "write"; network?: string[] },
>(tools: readonly T[], bound?: Bound | null): T[] {
  return tools.filter((tool) => {
    const toolName = tool.toolName ?? tool.name ?? "";
    return isToolAllowedByBound(
      { namespace: tool.namespace, toolName, access: tool.access, network: tool.network },
      bound,
    );
  });
}

export {
  isToolAllowedByBound as isToolAllowed,
  assertInputsAllowed as checkInputBounds,
  narrowJsonSchemaWithInputs as narrowToolInputSchema,
};

