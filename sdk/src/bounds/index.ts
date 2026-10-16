export type {
  Access,
  AllowDeny,
  Bound,
  McpAnnotations,
  ToolDescriptor,
} from "./types.js";

export { BoundSchema } from "./types.js";

// Tool filtering. `filterToolsQualified` is the one to use when the result
// gates invocation — bare names cannot tell two namespaces' `status` apart.
export {
  filterTools,
  filterToolsQualified,
  filterToolObjects,
  isToolAllowedByBound,
  matchesToolPattern,
  qualifyToolId,
} from "./filter-tools.js";

// Bound guards — per-call enforcement
export {
  isFileDenied,
  isFileAllowed,
  isBashDenied,
  boundHasProcessRestrictions,
  readTwin,
} from "./bound-guards.js";
export {
  BARRY_CONFIG_WRITE_DENY_PATTERNS,
  BARRY_CONFIG_PROTECTION_BOUND,
  protectedConfigPaths,
  isProtectedConfigPath,
  isConfigWriteBlocked,
} from "./config-protection.js";

// Bound merging — union of denials and clause-preserving intersection of allowlists.
export {
  mergeAllowDeny,
  mergeInputs,
  mergeBounds,
  mergeNetwork,
  boundHasContent,
} from "./merge-bounds.js";

// Program-name classifier — deny/allow by resolved argv[0] across chains,
// wrappers, and substitutions; fails closed on obfuscated/unparseable input.
export { classifyBashCommand, isProgramDenied, checkBashBound } from "./bash-classifier.js";

// File-write classifier — spots shell commands that patch files (python -c,
// sed -i, `> file`) so they can be routed to the edit tools, which claim the
// file and require an intent. Tuned against false positives, not completeness.
export { classifyFileWrite } from "./file-write-classifier.js";
export type { FileWriteFinding } from "./file-write-classifier.js";
export type { BashClassification } from "./bash-classifier.js";

// Network classifier — maps bash commands and tools to semantic network
// actions (git:push, http:write, etc.), domains, and URL globs for bound enforcement.
export {
  expandActions,
  classifyNetworkActions,
  isNetworkActionDenied,
  isDomainDenied,
  extractDomainsFromCommand,
  extractHttpRequestsFromCommand,
  extractSandboxAllowedDomains,
  parseNetworkRule,
  canonicalizeNetworkUrl,
  matchesUrlPattern,
  checkNetworkBound,
  getImpliedDeniedTools,
  KNOWN_NETWORK_ACTIONS,
  NETWORK_TOOL_ACTIONS,
  NETWORK_TOOL_URL_PARAMS,
  type ParsedNetworkRule,
  type ExtractedHttpRequest,
} from "./network-classifier.js";

export const CORE_NAMESPACES = new Set([
  "bash",
  "devops",
  "filesystem",
  "barry",
  "session",
  "artifacts",
  "artifacts-sdk",
  "git",
]);

export {
  resolveBound,
  resolveToolCallBounds,
  assertNodeAllowed,
  assertToolAllowed,
  nativeToolDenials,
  type ToolCallBounds,
} from "./resolve-bound.js";
export {
  applyBoundGuards,
  assertInputsAllowed,
  checkInputBounds,
  narrowJsonSchemaWithInputs,
  narrowToolInputSchema,
  narrowInputSchemaForBound,
  guardToolCall,
  isToolAllowed,
  filePathParameters,
  type BoundGuardTool,
} from "./tool-guards.js";
export {
  approveWorkflowBounds,
  intersectWorkflowBounds,
  assertBoundDelegation,
  boundFingerprint,
  approvedBoundsSchema,
  type ApprovedBounds,
} from "./workflow-bounds.js";
export * from "./native-tools.js";
export * from "./workflow-bounds.js";

