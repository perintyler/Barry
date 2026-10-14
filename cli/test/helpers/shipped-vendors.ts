/** Explicit provider composition for test fixtures; production reads installation selections. */
import { registeredVendorRows, mergeVendorFactories, assembleVendors, type VendorFactories } from "@barry-rocks/sdk/adapters/models";

import type { Vendor } from "@barry-rocks/sdk/adapters/models";
import { COMPLETION_FACTORIES as ANTHROPIC_COMPLETION_FACTORIES } from "@barry-rocks/completion-anthropic";
import { COMPLETION_FACTORIES as OLLAMA_COMPLETION_FACTORIES } from "@barry-rocks/completion-ollama";
import { COMPLETION_FACTORIES as LLAMACPP_COMPLETION_FACTORIES } from "@barry-rocks/completion-llamacpp";
import { EMBEDDING_FACTORIES } from "@barry-rocks/embedding-ollama";
import { DECISION_FACTORIES as TYPESAFE_DECISION_FACTORIES } from "@barry-rocks/decision-typesafe";
import { DECISION_FACTORIES as VON_DECISION_FACTORIES } from "@barry-rocks/decision-von";
import { DECISION_FACTORIES as ANTHROPIC_DECISION_FACTORIES } from "@barry-rocks/decision-anthropic";
import { DECISION_FACTORIES as OLLAMA_DECISION_FACTORIES } from "@barry-rocks/decision-ollama";

export async function shippedVendorRows(): Promise<Vendor[]> {
  return registeredVendorRows();
}

export const SHIPPED_VENDOR_FACTORIES: VendorFactories = mergeVendorFactories(
  ANTHROPIC_COMPLETION_FACTORIES,
  OLLAMA_COMPLETION_FACTORIES,
  LLAMACPP_COMPLETION_FACTORIES,
  EMBEDDING_FACTORIES,
  TYPESAFE_DECISION_FACTORIES,
  VON_DECISION_FACTORIES,
  ANTHROPIC_DECISION_FACTORIES,
  OLLAMA_DECISION_FACTORIES,
);

/** The shipped catalog with its call code attached — what `createModels` takes. */
export async function shippedVendors(): Promise<Vendor[]> {
  return assembleVendors(await shippedVendorRows(), SHIPPED_VENDOR_FACTORIES);
}
