import { isProgramDenied } from "./bash-classifier.js";
import {
  hasUnknownDomainTarget,
  isNetworkActionDenied,
  isDomainDenied,
  extractDomainsFromCommand,
  expandActions,
  NETWORK_TOOL_ACTIONS,
  NETWORK_TOOL_URL_PARAMS,
} from "./network-classifier.js";
import type { ToolContext } from "../tools/define-tool.js";
import type { Bound } from "./types.js";
import {
  isBashDenied,
  isFileDenied,
  isFileAllowed,
  canonicalFilePath,
  isFileSearchDenied,
} from "./bound-guards.js";
export interface BoundGuardTool {
  name: string;
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
/** First-party definitions expose their path fields; native tools use legacy names. */
export function filePathParameters(tool: Pick<BoundGuardTool, "name" | "schema">): string[] {
  const declared = Object.keys(tool.schema ?? {}).filter((key) => /path$/i.test(key));
  const legacy = nativePathParams[tool.name] ?? (tool.name === "open" ? "path" : undefined);
  return [...new Set([...declared, ...(legacy ? [legacy] : [])])];
}
export function applyBoundGuards<T extends BoundGuardTool>(tools: T[], scope: Bound): T[] {
  const fileDeny = scope.files?.deny;
  const fileAllow = scope.files?.allowOnly;
  const bashDeny = scope.bash?.deny;
  const denyPrograms = scope.bash?.denyPrograms;
  const networkActions = scope.network?.actions;
  const networkDomains = scope.network?.domains;
  const hasFileGuards = !!fileDeny?.length || fileAllow !== undefined;
  const hasBashGuards = !!bashDeny?.length || !!denyPrograms?.length;
  const hasNetworkGuards = !!networkActions?.length || !!networkDomains?.length;
  if (!hasFileGuards && !hasBashGuards && !hasNetworkGuards) return tools;
  // Pre-expand network actions for structured tool checks (wrap-time, not per-call)
  const expandedNetworkActions = networkActions?.length ? expandActions(networkActions) : null;
  return tools.map((tool) => {
    const pathParams = filePathParameters(tool);
    if (pathParams.length && hasFileGuards) {
      const original = tool.handler;
      return {
        ...tool,
        handler: async (params, context) => {
          for (const pathParam of pathParams) {
            const filePath =
              params[pathParam] ??
              (["Grep", "Glob", "LS"].includes(tool.name) ? process.cwd() : undefined);
            if (
              typeof filePath === "string" &&
              !(tool.name === "open" && /^https?:\/\//i.test(filePath))
            ) {
              let normalized: string;
              try {
                normalized = canonicalFilePath(filePath, fileAllow !== undefined);
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
              if (denyMatch || searchMatch)
                throw new Error(
                  `Access denied: path matches deny pattern "${denyMatch ?? searchMatch}"`,
                );
              if (fileAllow && !isFileAllowed(normalized, fileAllow))
                throw new Error(
                  "Access denied: path is outside this session's allowed paths (no match in files.allowOnly)",
                );
            }
          }
          return original(params, context);
        },
      };
    }
    // Structured network tools (push, etc.): static deny at wrap time
    // since these tools always perform the same network action.
    const toolNetActions = NETWORK_TOOL_ACTIONS[tool.name];
    if (toolNetActions && expandedNetworkActions) {
      const blocked = toolNetActions.find((a) => expandedNetworkActions.has(a));
      if (blocked) {
        return {
          ...tool,
          handler: async () => {
            throw new Error(
              `Access denied: '${tool.name}' is restricted by network policy — action '${blocked}' is denied in this session.`,
            );
          },
        };
      }
    }
    // Tools that take a URL parameter (WebFetch): apply domain rules per call.
    // Domain denial used to cover Bash only, so a denied host was still
    // reachable through the structured fetch tools.
    const urlParam = NETWORK_TOOL_URL_PARAMS[tool.name];
    if (urlParam && networkDomains?.length) {
      const original = tool.handler;
      return {
        ...tool,
        handler: async (params, context) => {
          const raw = params[urlParam];
          if (typeof raw === "string") {
            for (const domain of extractDomainsFromCommand(raw)) {
              const match = isDomainDenied(domain, networkDomains);
              if (match) {
                throw new Error(
                  `Access denied: network requests to '${domain}' are restricted in this session (matches pattern '${match}').`,
                );
              }
            }
          }
          return original(params, context);
        },
      };
    }
    if (tool.name === "Bash" && (hasFileGuards || hasBashGuards || hasNetworkGuards)) {
      const original = tool.handler;
      return {
        ...tool,
        handler: async (params, context) => {
          const command = typeof params.command === "string" ? params.command : "";
          if (hasFileGuards)
            throw new Error(
              "Access denied: Bash is withheld by this file bound; use structured filesystem tools",
            );
          // Program-name denial (git/gh): robust across chains, wrappers, and
          // substitutions; fails closed on obfuscated input.
          if (denyPrograms?.length) {
            const prog = isProgramDenied(command, denyPrograms);
            if (prog) {
              throw new Error(
                prog === "git" || prog.startsWith("git")
                  ? `Access denied: '${prog}' is restricted to structured tools in this session — use status, diff, log, add, commit, push, and the other git_* tools instead of shelling out to git.`
                  : `Access denied: '${prog}' is not permitted in this session's shell — use the corresponding structured tools instead.`,
              );
            }
          }
          if (bashDeny?.length) {
            const match = isBashDenied(command, bashDeny);
            if (match) throw new Error(`Access denied: command matches deny pattern "${match}"`);
          }
          // Network action denial: classify the command's network actions and
          // check against the denied set.
          if (networkActions?.length) {
            const action = isNetworkActionDenied(command, networkActions);
            if (action) {
              throw new Error(
                `Access denied: network action '${action}' is restricted in this session.`,
              );
            }
          }
          // Domain denial: best-effort extraction of URLs from known programs.
          if (networkDomains?.length) {
            if (hasUnknownDomainTarget(command)) {
              throw new Error(
                "Access denied: cannot determine the network target under this domain bound.",
              );
            }
            const domains = extractDomainsFromCommand(command);
            for (const domain of domains) {
              const match = isDomainDenied(domain, networkDomains);
              if (match) {
                throw new Error(
                  `Access denied: network requests to '${domain}' are restricted in this session (matches pattern '${match}').`,
                );
              }
            }
          }
          return original(params, context);
        },
      };
    }
    return tool;
  });
}
