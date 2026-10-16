/** Expectations are literal: none are computed using Barry's resolver. */
export const boundsFixture = {
  bag: "acceptance-documents",
  ungrantedBag: "acceptance-unselected",
  namespace: "documents",
  guidance: "Fixture guidance asks to call write_document.",
  selectedBounds: ["acceptance.readonly", "acceptance.native"],
  allowed: ["read_document"],
  denied: ["write_document", "close_issue", "read_unselected"],
  malformed: [
    { entry: "acceptance.missing-bound", error: "unknown selected bound" },
    { entry: "acceptance.readonly", error: "acceptance\\.readonly is listed twice" },
    {
      entry: {
        "acceptance:invalid": {
          description: "Invalid qualified name",
          tools: { deny: ["*:write"] },
        },
      },
      error: "identity definitions must have bare names",
    },
  ],
  tools: [
    { name: "read_document", namespace: "documents", access: "read" },
    { name: "write_document", namespace: "documents", access: "write" },
    { name: "close_issue", namespace: "issues", access: "write" },
    { name: "read_unselected", namespace: "unselected", access: "read" },
  ],
  bounds: [
    {
      "acceptance.readonly": {
        description: "Deny write tools and unselected bag tools",
        tools: { deny: ["*:write", "unselected:*"] },
      },
    },
    {
      "acceptance.native": {
        description: "Deny ForbiddenNative on acceptance harness",
        tools: { deny: ["acceptance:ForbiddenNative"] },
      },
    },
  ],
} as const;
