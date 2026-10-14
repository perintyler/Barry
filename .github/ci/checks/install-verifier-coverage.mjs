import { parse } from "yaml";
import { mirrorGuard } from "./mirror-workflows.mjs";

/** A runbook mention cannot substitute for the required disposable gate. */
export function installVerifierProblems(source) {
  const workflow = parse(source);
  const job = workflow?.jobs?.disposable;
  const steps = job?.if === mirrorGuard && !job?.["continue-on-error"] ? job?.steps ?? [] : [];
  const commands = steps.filter(step => step.if === undefined && !step["continue-on-error"])
    .map(step => typeof step.run === "string" ? step.run.trim() : "");
  return ["verify-install.ts", "verify-nodes.ts"].filter(script =>
    !commands.includes(`node --import tsx cli/scripts/${script}`),
  ).map(script => `test-install.yml: disposable job must run node --import tsx cli/scripts/${script} unconditionally`);
}
