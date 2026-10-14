/**
 * The model contracts: what a model can be asked, and the `Models` door every
 * caller reaches one through.
 *
 * Everything needed to WRITE a vendor or call a model, and nothing that
 * implements one. The vendors Barry ships live in registered bags’ vendor declarations with the call
 * code attached by the installation composition root; a
 * composition root hands them to `createModels` and installs the result.
 */
export {
  ModelUnavailableError,
  type Answer,
  type Completion,
  type CompletionModel,
  type CompletionRequest,
  type Decision,
  type DecisionModel,
  type DecisionRequest,
  type EmbeddingModel,
  type EmbeddingRequest,
  type Embeddings,
  type Question,
  type TokenUsage,
} from "./kinds.js";
export { installModels, installedModels, ModelsNotInstalled, type AvailableModels, type Models } from "./models.js";
export { createModels, type ModelsOptions } from "./create.js";

export {
  keylessRouteRefusal,
  reachableVendors,
  routedEndpoint,
  routeModel,
  routedVendorOf,
  RouteRefused,
  type Route,
  type RouteRequest,
  type RoutingHarness,
} from "./route.js";
export {
  isOfferedModel,
  offeredModels,
  suggestOfferedModels,
  type OfferedModelInfo,
  type OfferingHarness,
} from "./offered.js";
export * from "./vendors/index.js";
export * from "./vendors/catalog.js";
export * from "./vendors/vendor-catalog.js";
export * from "./vendors/shipped-catalog.js";
export * from "./providers.js";
export * from "./prompted-questions.js";
export * from "../decisions/index.js";
export * from "../../services/checks.js";
