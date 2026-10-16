import { fileURLToPath } from "node:url";
export { createWorkflowServer } from "./server.js";
export const builtinArtifact = fileURLToPath(new URL("./builtin-artifact.mjs", import.meta.url));
export const jobArtifact = fileURLToPath(new URL("./job-artifact.mjs", import.meta.url));
export const processArtifact = fileURLToPath(new URL("./process-artifact.mjs", import.meta.url));
export const agentArtifact = fileURLToPath(new URL("./agent-artifact.mjs", import.meta.url));
