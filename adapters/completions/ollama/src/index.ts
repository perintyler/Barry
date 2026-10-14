import type { VendorFactories } from "@barry-rocks/sdk/adapters/models";
import { ollamaCompletionModel, listPulled } from "./api.js";
import { checkOllama } from "./check.js";
export { ollamaCompletionModel } from "./api.js";
export const COMPLETION_FACTORIES: VendorFactories = {
  completion: { ollama: ollamaCompletionModel },
  listModels: { ollama: listPulled },
  check: { ollama: checkOllama },
};
