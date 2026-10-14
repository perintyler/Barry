export {
  resolveSkillDirs,
  buildSkillsPlugin,
} from "./plugin-mount.js";

// The actions catalog owns SKILL.md discovery; direct parsers remain on ./skill-catalog.
// See docs/decisions/0017-sdk-discovery-and-wire-contracts.md.

export {
  buildActionsIndex,
  type BuildActionsIndexOptions,
} from "./action-index.js";


export * from "./action-catalog.js";
export * from "./action-commands.js";
export * from "./resolve-agent.js";
export * from "./action-yaml.js";
export * from "./action-manifest.js";
export * from "./work-contract.js";
export * from "./action-preflight.js";
export * from "./action-validate.js";
export * from "./action-run-spec.js";
