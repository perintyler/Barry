/** Explicit installed service registration; no workflow admission or dispatch. */
import Database from "better-sqlite3";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Adapters } from "@barry-rocks/sdk/adapters/harnesses";
import type { InstalledAdapterSelection } from "@barry-rocks/sdk/internal/adapters";
import { WorkArtifactStore } from "@barry-rocks/sdk/internal/workflows";
import {
  prepareWorkflowProcessHarness,
  type WorkflowProcessHarnessOptions,
} from "./workflow-process-harness.js";
import type { WorkflowHarnessLaunch, PreparedWorkflowHarness } from "./workflow-session-backend.js";
import {
  WorkflowRuntimeRegistry,
  type RegisteredWorkflowRuntime,
} from "./workflow-runtime-registry.js";

const configuration = z.strictObject({
  version: z.literal(1),
  harnesses: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/))
    .min(1)
    .max(100)
    .refine((values) => new Set(values).size === values.length),
  allowedRoots: z.array(z.string().refine(isAbsolute)).min(1).max(100),
  registrationTimeoutMs: z.number().int().min(1000).max(600000).default(60000),
});
function readConfiguration(path: string): unknown {
  if (!isAbsolute(path) || realpathSync(path) !== path)
    throw new Error("WorkflowRuntimeInstallationConfigurationUnavailable");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.size > 65536 ||
      (before.mode & 0o022) !== 0 ||
      (process.getuid && before.uid !== process.getuid())
    )
      throw new Error("WorkflowRuntimeInstallationConfigurationUnavailable");
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd),
      current = lstatSync(path);
    if (
      length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      current.isSymbolicLink() ||
      current.ino !== after.ino ||
      current.dev !== after.dev
    )
      throw new Error("WorkflowRuntimeInstallationConfigurationChanged");
    return JSON.parse(bytes.subarray(0, length).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}
function privateDirectory(path: string): string {
  if (!isAbsolute(path)) throw new Error("WorkflowRuntimeInstallationDirectoryUnavailable");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path),
    canonical = realpathSync(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error("WorkflowRuntimeInstallationDirectoryUnavailable");
  return canonical;
}

export interface InstalledWorkflowRuntimeInstallation {
  registry: WorkflowRuntimeRegistry;
  /** Trusted composition only: immutable code/profile custody, never credentials. */
  artifacts: WorkArtifactStore;
  registrations: RegisteredWorkflowRuntime[];
  executionSpool: string;
  prepare(
    generation: string,
    options: Pick<WorkflowProcessHarnessOptions, "inertEnvironment" | "authorize" | "configure">,
    launch: WorkflowHarnessLaunch,
  ): Promise<PreparedWorkflowHarness>;
  close(): void;
}

export async function registerInstalledWorkflowRuntimes(options: {
  configuration: string;
  directory: string;
  adapters: Pick<Adapters, "installed"> & InstalledAdapterSelection;
}): Promise<InstalledWorkflowRuntimeInstallation> {
  const selected = configuration.parse(readConfiguration(options.configuration));
  // This explicit profile pins code, not arbitrary dynamic providers, plugins,
  // MCP servers or host containment. No session credential/config is selected.
  const directory = privateDirectory(options.directory),
    spoolRoot = privateDirectory(join(directory, "registration-spool"));
  const path = join(directory, "generations.db"),
    fd = openSync(
      path,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("WorkflowRuntimeInstallationStoreUnavailable");
  } finally {
    closeSync(fd);
  }
  const db = new Database(path);
  let artifacts: WorkArtifactStore;
  try {
    artifacts = new WorkArtifactStore(
      privateDirectory(join(directory, "artifacts")),
      256 * 1024 * 1024,
    );
  } catch (error) {
    try {
      db.close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "WorkflowRuntimeInstallationFailed");
    }
    throw error;
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    try {
      db.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      artifacts.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length)
      throw new AggregateError(failures, "WorkflowRuntimeInstallationCloseFailed");
  };
  try {
    const registry = new WorkflowRuntimeRegistry({
      db,
      artifacts,
      adapters: options.adapters,
      spoolRoot,
      allowedRoots: selected.allowedRoots,
      workerEntrypoint: fileURLToPath(
        new URL(
          import.meta.url.endsWith(".ts")
            ? "./workflow-harness-child.ts"
            : "./workflow-harness-child.js",
          import.meta.url,
        ),
      ),
    });
    db.pragma("journal_mode=WAL");
    db.pragma("synchronous=FULL");
    const registrations: RegisteredWorkflowRuntime[] = [];
    for (const harness of selected.harnesses)
      registrations.push(
        await registry.register(harness, Date.now() + selected.registrationTimeoutMs),
      );
    const executionSpool = privateDirectory(join(directory, "execution-spool"));
    return {
      registry,
      artifacts,
      registrations,
      executionSpool,
      close,
      prepare: async (generation, selectedOptions, launch) => {
        if (closed) throw new Error("WorkflowRuntimeInstallationClosed");
        const retained = registry.descriptor(generation);
        if (!retained) throw new Error("WorkflowRuntimeGenerationUnavailable");
        return prepareWorkflowProcessHarness(
          {
            ...selectedOptions,
            harnessId: retained.registration.harness,
            spoolRoot: executionSpool,
            runtime: { artifacts, reference: retained.registration.runtime },
          },
          launch,
        );
      },
    };
  } catch (error) {
    try {
      close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "WorkflowRuntimeInstallationFailed");
    }
    throw error;
  }
}
