import type { VendorFactories } from "@barry-rocks/sdk/adapters/models";
import { messagesCompletionModel } from "./messages.js";
export { messagesCompletionModel } from "./messages.js";
export const COMPLETION_FACTORIES: VendorFactories = {
  completion: { anthropic: messagesCompletionModel },
};
