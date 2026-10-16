/** Credential-free retained-code inspection. Only the owned guardian signals. */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareOwnedProcess, type WorkArtifactStore } from "@barry-rocks/sdk/internal/workflows";
import { readInstalledAdapterPackage } from "@barry-rocks/sdk/internal/adapters";
import type { WorkflowHarnessHandle } from "./workflow-session-backend.js";
import { materializeWorkflowRuntime, type WorkflowRuntimeReference } from "./workflow-runtime-closure.js";
import { canonicalWorkflowHarnessJson, encodeWorkflowHarnessMessage, parseWorkflowHarnessMessage } from "./workflow-harness-protocol.js";

export async function probeWorkflowRuntimeRegistration(options: {
  artifacts: WorkArtifactStore; runtime: WorkflowRuntimeReference; harness: string; directory: string;
  declaration: unknown; packageName: string; packageVersion: string; deadline: number; recordHandle(handle: WorkflowHarnessHandle): void;
}): Promise<void> {
  options = { ...options, runtime: structuredClone(options.runtime), declaration: structuredClone(options.declaration) };
  const binding = { sessionId: randomUUID(), turnId: randomUUID(), segmentId: randomUUID(), owner: randomUUID() };
  mkdirSync(options.directory, { mode: 0o700 });
  const retained = materializeWorkflowRuntime(options.artifacts, options.runtime, options.harness, join(options.directory, "runtime"));
  const adapterPackage = retained.manifest.packages.find(pkg => retained.manifest.adapter.startsWith(`packages/${pkg.id}/`));
  if (!adapterPackage || adapterPackage.name !== options.packageName || adapterPackage.version !== options.packageVersion) throw new Error("WorkflowRuntimePackageSelectionChanged");
  const packageRoot = join(options.directory, "runtime", "packages", adapterPackage.id), pkg = readInstalledAdapterPackage(packageRoot);
  if (pkg.name !== options.packageName || pkg.version !== options.packageVersion || join(packageRoot, pkg.entry) !== retained.adapter) throw new Error("WorkflowRuntimePackageSelectionChanged");
  const owned = await prepareOwnedProcess({ deadline: options.deadline, runtime: retained.runtime, bootstrap: retained.guardian });
  let timer: ReturnType<typeof setTimeout> | undefined, unsubscribe: (() => void) | undefined;
  let completed = false;
  const failures: unknown[] = [];
  try {
    // Durable registration journal owns the handle before any adapter import.
    options.recordHandle({ ...owned.handle });
    const responseId = randomUUID();
    let ready!: () => void, reject!: (error: Error) => void, inspected!: (value: unknown) => void;
    const failure = new Promise<never>((_resolve, fail) => { reject = fail; });
    const readiness = new Promise<void>(resolve => { ready = resolve; });
    const inspection = new Promise<unknown>(resolve => { inspected = resolve; });
    const bounded = <T>(operation: Promise<T>) => Promise.race([operation, failure]);
    void failure.catch(() => {});
    void owned.closed.then(() => reject(new Error("WorkflowRuntimeRegistrationClosed")));
    timer = setTimeout(() => reject(new Error("WorkflowRuntimeRegistrationExpired")), Math.max(1, Math.min(options.deadline - Date.now(), 2_147_483_647)));
    unsubscribe = owned.onMessage(raw => {
      try {
        const message = parseWorkflowHarnessMessage(raw, binding);
        if (message.kind === "ready" && message.runtimeDigest === options.runtime.digest) ready();
        else if (message.kind === "response" && message.id === responseId && !message.error) inspected(message.value);
        else throw new Error("WorkflowRuntimeRegistrationProtocolError");
      } catch { reject(new Error("WorkflowRuntimeRegistrationProtocolError")); }
    });
    await bounded(owned.launch({ command: retained.runtime, args: ["--import", retained.guard, retained.worker, canonicalWorkflowHarnessJson(binding), options.directory, "--registration-probe"],
      cwd: options.directory, env: { PATH: "/usr/bin:/bin", HOME: options.directory, BARRY_HOME: options.directory,
        PI_CODING_AGENT_DIR: options.directory, TMPDIR: options.directory, BARRY_WORKFLOW_CLOSURE_SHA256: options.runtime.digest } }));
    await bounded(readiness);
    await bounded(owned.send(JSON.parse(encodeWorkflowHarnessMessage({ version: 1, binding, id: responseId, kind: "request", method: "inspect",
      value: { harnessId: options.harness, adapterModule: pathToFileURL(retained.adapter).href } }))));
    if (canonicalWorkflowHarnessJson(await bounded(inspection)) !== canonicalWorkflowHarnessJson(options.declaration)) throw new Error("WorkflowRuntimeRegistrationDeclarationChanged");
    completed = true;
  } catch (error) { failures.push(error); }
  finally {
    clearTimeout(timer);unsubscribe?.();
  }
  // Success is never published until the native group is strictly absent.
  // Retain both inspection and cleanup failures; neither can erase the other.
  try { await owned.dispose(); } catch (error) { failures.push(error); }
  if (!owned.proveCessation()) failures.push(new Error("WorkflowRuntimeRegistrationCessationUnknown"));
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "WorkflowRuntimeRegistrationFailed");
  if (completed) rmSync(options.directory, { recursive: true, force: true });
}
