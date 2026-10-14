import type { VendorFactories } from "@barry-rocks/sdk/adapters/models";
import { llamacppCompletionModel, listLlamaModels } from "./api.js";
import { checkLlama } from "./check.js";
export { llamacppCompletionModel } from "./api.js";
export const COMPLETION_FACTORIES: VendorFactories = {
  completion: { llamacpp: llamacppCompletionModel },
  listModels: { llamacpp: listLlamaModels },
  check: { llamacpp: checkLlama },
};
