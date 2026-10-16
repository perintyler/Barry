import { expect, it } from "vitest";
import { explainBlockedRun } from "../web/waiting-reasons.js";

it("turns policy and uncertain-outcome codes into actionable, distinct guidance", () => {
  expect(explainBlockedRun("PolicyRevoked: bag removed")).toEqual({
    title: "Permissions changed after this run was approved. Review the current scope and reauthorize only after outstanding effects are reconciled.",
    detail: "bag removed",
  });
  expect(explainBlockedRun("OutcomeUnknown: session acknowledgement lost")).toEqual({
    title: "An effect or session turn may have completed without an acknowledgement. Reconcile its destination receipt before retrying.",
    detail: "session acknowledgement lost",
  });
  expect(explainBlockedRun("SessionBusy").title).toContain("continuing session");
  expect(explainBlockedRun("UnclassifiedFailure")).toEqual({ title: "Run blocked", detail: "UnclassifiedFailure" });
});
