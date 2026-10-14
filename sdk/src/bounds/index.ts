export type {
  Access,
  Bound,
  AgentTrait,
  McpAnnotations,
  ToolMeta,
} from "./types.js";

export { BoundSchema, ALLOW_DOMAINS_NEEDS_SANDBOX } from "./types.js";

export { resolveTraits } from "./resolve-traits.js";

// Tool filtering. `filterToolsQualified` is the one to use when the result
// gates invocation — bare names cannot tell two namespaces' `status` apart.
export { filterTools, filterToolsQualified, qualifyToolId } from "./filter-tools.js";

// Bound guards — per-call enforcement
export { isFileDenied, isFileAllowed, isBashDenied } from "./bound-guards.js";
// Bound merging — union of denials across trait/named/barry/inline sources.
// Shared so the MCP server and API server resolve identical effective bounds.
export {
  mergeBounds,
  mergeNetwork,
  boundHasContent,
} from "./merge-bounds.js";

// Program-name classifier — deny by resolved argv[0] (git/gh) across chains,
// wrappers, and substitutions; fails closed on obfuscated/unparseable input.
export { classifyBashCommand, isProgramDenied } from "./bash-classifier.js";

// File-write classifier — spots shell commands that patch files (python -c,
// sed -i, `> file`) so they can be routed to the edit tools, which claim the
// file and require an intent. Tuned against false positives, not completeness.
export { classifyFileWrite } from "./file-write-classifier.js";
export type { FileWriteFinding } from "./file-write-classifier.js";
export type { BashClassification } from "./bash-classifier.js";

// Network classifier — maps bash commands and tools to semantic network
// actions (git:push, http:write, etc.) for bound enforcement.
export {
  expandActions,
  classifyNetworkActions,
  isNetworkActionDenied,
  isDomainDenied,
  extractDomainsFromCommand,
  getImpliedDeniedTools,
  NETWORK_TOOL_ACTIONS,
  NETWORK_TOOL_URL_PARAMS,
} from "./network-classifier.js";

/**
 * Barry's own namespaces, as opposed to a vendor's.
 *
 * This no longer decides which namespaces get their own `/mcp/ns/<namespace>`
 * endpoint — every namespace does, which is what gives the agent
 * `mcp__linear__*` and `mcp__git__*` instead of one flat `mcp__barry__*`.
 *
 * Its only remaining job is cosmetic: on the aggregate `/mcp` endpoint, where
 * everything really does share the `mcp__barry__` prefix, vendor tools get a
 * `[Linear] ` tag on their description to show where they came from. Tagging
 * Barry's own tools there would be noise.
 */
export const CORE_NAMESPACES = new Set([
  // The shell/host bag `system` was dissolved: its shell tools stamp `bash`,
  // `open` moved into `filesystem`, and `status`/`support` stamp `devops` from
  // the barry-devops bag. `changes` likewise folded into `filesystem`. Both
  // retired names were kept here for a release and are now gone.
  "bash",
  "devops",
  "filesystem",
  "barry",
  "session",
  "artifacts",
  "artifacts-sdk",
  "git",
]);

export { expandTraitNames, resolveEffectiveBound, nativeToolDenials } from "./effective-bound.js";

export { resolveExecutionContext, assertNodeAllowed, assertToolAllowed, type ExecutionContext } from "./execution-context.js";
export { applyBoundGuards, type BoundGuardTool } from "./tool-guards.js";
export { approveExecutionScope, intersectExecutionScope, assertScopeDelegation, scopeFingerprint, executionScopeSchema, type ExecutionScope } from "./execution-scope.js";
export * from "./native-policy.js";
export * from "./execution-scope.js";
