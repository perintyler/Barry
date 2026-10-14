/** Expectations are literal: none are computed using Barry's resolver. */
export const policyFixture = {
  bag: "acceptance-documents",
  ungrantedBag: "acceptance-unselected",
  namespace: "documents",
  guidance: "Fixture guidance asks to call write_document.",
  selected: ["acceptance.editor", "acceptance.reviewer", "acceptance.harness"],
  allowed: ["read_document"],
  denied: ["write_document", "close_issue", "read_unselected"],
  malformed: [
    { name: "acceptance.missing-restriction", error: "unknown selected trait" },
    { name: "acceptance.missing-include", error: "unknown included trait" },
    { name: "acceptance.cycle-a", error: "trait composition cycle" },
    { name: "acceptance.missing-bound", error: "references unknown bound" },
  ],
  tools: [
    { name: "read_document", namespace: "documents", access: "read" },
    { name: "write_document", namespace: "documents", access: "write" },
    { name: "close_issue", namespace: "issues", access: "write" },
    { name: "read_unselected", namespace: "unselected", access: "read" },
  ],
  traits: [
    { name: "acceptance.harness", namespaces: [], access: "read", harnessTraits: { acceptance: "acceptance.native" } },
    { name: "acceptance.native", namespaces: [], access: "read", bound: { nativeTools: { acceptance: ["ForbiddenNative"] } } },
    { name: "acceptance.reader", namespaces: ["documents"], access: "read" },
    { name: "acceptance.editor", namespaces: ["documents", "issues"], access: "readwrite", includes: ["acceptance.reader"] },
    { name: "acceptance.reviewer", namespaces: [], access: "read", includes: ["acceptance.reader"], boundNames: ["acceptance.readonly"] },
  ],
} as const;
