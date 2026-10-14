const blockedReasons = [
  [/^PolicyRevoked(?::\s*(.*))?$/, "Permissions changed after this run was approved. Review the current scope and reauthorize only after outstanding effects are reconciled."],
  [/^OutcomeUnknown(?::\s*(.*))?$/, "An effect or session turn may have completed without an acknowledgement. Reconcile its destination receipt before retrying."],
  [/^SessionBusy(?::\s*(.*))?$/, "Another turn still owns this continuing session. Wait for or reconcile that turn before submitting another."],
  [/^ReconciliationRequired(?::\s*(.*))?$/, "This run has unresolved external work. Inspect its session and effect receipts before resuming."],
  [/^RequiredContainmentUnavailable(?::\s*(.*))?$/, "No available worker can enforce the run’s required execution profile."],
];

export function explainBlockedRun(error) {
  if (typeof error !== "string") return { title: "Run blocked", detail: "The run is blocked; inspect its event history and resource receipts." };
  for (const [pattern, title] of blockedReasons) {
    const match = pattern.exec(error);
    if (match) return { title, detail: match[1] || error };
  }
  return { title: "Run blocked", detail: error };
}
