/**
 * TypeSafe's vendor specifics: a hosted API that will not serve without a
 * key, and where to get one. The wire protocol is `systemone.ts`, shared
 * with the local Von daemon.
 */
import type { DecisionModel, Endpoint, VendorFactories } from "@barry-rocks/sdk/adapters/models";

import { systemoneDecisionModel } from "@barry-rocks/decision-systemone";

export function jevDecisionModel(model: string, endpoint: Endpoint): DecisionModel {
  return systemoneDecisionModel({
    vendorId: "typesafe",
    model,
    endpoint,
    label: "Jev",
    credentialEnv: "TYPESAFE_API_KEY",
    hint: "early access: console.typesafe.ai",
    keyRequired: true,
  });
}


export const DECISION_FACTORIES: VendorFactories = { decision: { typesafe: jevDecisionModel } };
