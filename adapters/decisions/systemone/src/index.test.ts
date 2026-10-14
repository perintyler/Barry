/**
 * The package's registry contract, and one behavior local to this package:
 * the System One question validation, refused before any request is sent.
 */
import { describe, expect, it } from "vitest";
import { systemoneDecisionModel } from "./index.js";

describe("systemoneDecisionModel", () => {
  const endpoint = { baseUrl: "https://systemone.test/v1", apiKey: "sk-test" };

  it("builds the ref from the vendor it serves", () => {
    const model = systemoneDecisionModel({ vendorId: "von", model: "von-latest", endpoint, label: "Von", credentialEnv: "VON_API_KEY", keyRequired: false });
    expect(model.ref).toBe("von/von-latest");
  });

  it("refuses a one-option choice before sending", async () => {
    const model = systemoneDecisionModel({ vendorId: "typesafe", model: "jev-latest", endpoint, label: "Jev", credentialEnv: "TYPESAFE_API_KEY", keyRequired: true });
    await expect(model.decide({ state: "s", questions: { color: { type: "choice", instructions: "?", options: ["red"] } } }))
      .rejects.toThrow(/needs at least 2 options/);
  });

  it("refuses when a required key is absent, and serves when it is optional", async () => {
    const required = systemoneDecisionModel({ vendorId: "typesafe", model: "jev-latest", endpoint: { baseUrl: endpoint.baseUrl }, label: "Jev", credentialEnv: "TYPESAFE_API_KEY", keyRequired: true });
    await expect(required.decide({ state: "s", questions: { ok: { type: "boolean", instructions: "?" } } }))
      .rejects.toThrow(/TYPESAFE_API_KEY is not set/);

    const optional = systemoneDecisionModel({ vendorId: "von", model: "von-latest", endpoint: { baseUrl: endpoint.baseUrl }, label: "Von", credentialEnv: "VON_API_KEY", keyRequired: false });
    await expect(optional.decide({ state: "s", questions: { ok: { type: "boolean", instructions: "?" } } }))
      .rejects.toThrow(/Failed to fetch|fetch failed|ECONNREFUSED|unreachable/i);
  });
});
