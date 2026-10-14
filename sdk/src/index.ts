/**
 * @barry-rocks/sdk: `Barry`, the one surface every caller uses (a bag's tool,
 * the CLI, a service, an app), and the domain objects it hands out. Authoring
 * helpers beyond `Barry.Tool` live on their subpaths (`/tools`, `/bags`).
 */
export * from "./barry/index.js";
export type { ToolContext, ToolDefinition, ToolShape, AnyToolDefinition } from "./tools/define-tool.js";
export type { StoreBinding } from "./stores/bindings.js";

export type { BarryClientOptions as ConnectOptions } from "./client/http.js";
export type { CredentialResolver } from "./client/credentials.js";
