/**
 * An installed adapter's record, as the installation's adapters.json holds one: the
 * declarations alone, with no mode claimed. A test overrides the fields it
 * reads, so a record here never asserts anything on a test's behalf.
 */
import type { InstalledAdapter } from "@barry-rocks/sdk/adapters/harnesses";

export function installedAdapter(id: string, overrides: Partial<InstalledAdapter> = {}): InstalledAdapter {
  return {
    packageName: `@fixture/${id}`,
    contractVersion: 1,
    id,
    label: id,
    requirements: {
      binary: { command: id, versionArgs: ["--version"], versionPattern: "(\\d+\\.\\d+\\.\\d+)", install: {}, pin: { version: "0.0.0", enforcedBy: "test" } },
    },
    capabilities: {
      mcpTransports: ["stdio"],
      toolDenial: "none",
      systemPromptFormat: "raw",
      skillsMount: "none",
      withoutKey: "unauthenticated",
      endpoint: "fixed",
    },
    tools: overrides.tools ?? [],
    defaultMode: "guest",
    modes: { hosted: null, instrumented: null, guest: null },
    path: `/adapters/${id}`,
    version: "0.0.0",
    installedAt: "2026-09-29T00:00:00.000Z",
    ...overrides,
  };
}
