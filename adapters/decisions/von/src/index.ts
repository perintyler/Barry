/**
 * Von's vendor specifics: a local daemon that speaks the TypeSafe protocol
 * byte-compatibly, and takes bearer auth only when the operator set
 * VON_API_KEY on it — so a missing key sends no header rather than refusing.
 * The wire protocol is `systemone.ts`, shared with hosted Jev.
 */
import type { DecisionModel, Endpoint, VendorFactories } from "@barry-rocks/sdk/adapters/models";

import { systemoneDecisionModel } from "@barry-rocks/decision-systemone";

export function vonDecisionModel(model: string, endpoint: Endpoint): DecisionModel {
  return systemoneDecisionModel({
    vendorId: "von",
    model,
    endpoint,
    label: "Von",
    credentialEnv: "VON_API_KEY",
    keyRequired: false,
  });
}


export const DECISION_FACTORIES: VendorFactories = { decision: { von: vonDecisionModel } };
