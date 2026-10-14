import { describe, it, expect } from "vitest";
import { parseManifestObject, parseManifestObjectSafe } from "../manifest.js";

const base = { name: "demo", description: "A bag for testing" };
const parse = (jobs: unknown) => parseManifestObject({ ...base, jobs }, "demo");
const error = (jobs: unknown) => String(parseManifestObjectSafe({ ...base, jobs }).error);

describe("jobs: in bag.yaml", () => {
  it("normalizes each kind of runs block", () => {
    const manifest = parse({
      reaper: {
        description: "Close sessions whose OS process is gone",
        runs: { using: "node", main: "src/reaper.ts", secrets: ["BARRY_SECRET"], env: ["DRY_RUN=0"] },
        timeout: "10m",
      },
      "name-session": { runs: { using: "process", command: ["uv", "run", "jobs/name_session.py"], "working-directory": "jobs" } },
      triage: { runs: { using: "action", action: "triage-failure" } },
    });
    expect(manifest.jobs?.reaper).toEqual({
      description: "Close sessions whose OS process is gone",
      requires: { tools: [], secrets: [], bins: [] },
      timeout: 600,
      runs: { using: "node", main: "src/reaper.ts", secrets: ["BARRY_SECRET"], env: [{ name: "DRY_RUN", source: "value", value: "0" }] },
    });
    expect(manifest.jobs?.["name-session"]?.runs).toEqual({ using: "process", command: ["uv", "run", "jobs/name_session.py"], workingDirectory: "jobs" });
    expect(manifest.jobs?.triage?.runs).toEqual({ using: "action", action: "triage-failure" });
  });

  it("carries the shared contract, labels included", () => {
    const job = parse({
      summarize: {
        version: 1,
        requires: { bins: ["ollama"], labels: { model: "local" } },
        input_schema: { type: "object", properties: { session: { type: "string" } } },
        output_schema: { type: "object" },
        runs: { using: "node", main: "src/summarize.mjs" },
      },
    }).jobs?.summarize;
    expect(job?.version).toBe("1");
    expect(job?.requires).toEqual({ tools: [], secrets: [], bins: ["ollama"], labels: { model: "local" } });
    expect(job?.inputSchema).toEqual({ type: "object", properties: { session: { type: "string" } } });
  });

  it("refuses a job that is not a well-formed contract", () => {
    expect(error({ x: { runs: { using: "node", main: "src/x.ts" }, input_schema: { type: "string" } } })).toMatch(/input_schema must have "type": "object"/);
    expect(error({ x: { runs: { using: "node", main: "../outside.ts" } } })).toMatch(/inside the bag/);
    expect(error({ x: { runs: { using: "process", command: [] } } })).toMatch(/jobs\.x\.runs\.command/);
    expect(error({ x: { runs: { using: "shell", script: "ls" } } })).toMatch(/jobs\.x\.runs/);
    expect(error({ Bad_Name: { runs: { using: "action", action: "a" } } })).toMatch(/kebab-case/);
  });

  it("takes an action job's schemas from its action", () => {
    expect(error({ x: { runs: { using: "action", action: "a" }, output_schema: { type: "object" } } })).toMatch(/takes `output_schema` from its action/);
    // Process fields configure a process; an action job has none.
    expect(error({ x: { runs: { using: "action", action: "a", secrets: ["S"] } } })).toMatch(/jobs\.x\.runs/);
  });

  it("refuses what a bound could not reach", () => {
    expect(error({ x: { bounds: ["no-files"], preflight: { command: "true" }, runs: { using: "node", main: "src/x.mjs" } } }))
      .toMatch(/bounded job cannot declare `preflight`/);
    expect(error({ x: { bounds: ["no-files"], runs: { using: "process", command: ["ls"] } } }))
      .toMatch(/`process` job cannot be bounded/);
    // Under its bound a job cannot run tsx or read past its own entry file.
    expect(error({ x: { bounds: ["no-files"], runs: { using: "node", main: "src/x.ts" } } }))
      .toMatch(/bounded node job's main must be one self-contained \.mjs or \.js file/);
  });

  it("qualifies the job's own bounds with the bag's name", () => {
    const manifest = parseManifestObject({
      ...base,
      bounds: { "no-files": { description: "No files", bound: { files: { allowOnly: [] } } } },
      jobs: { x: { bounds: ["no-files", "other:bound"], runs: { using: "node", main: "src/x.mjs" } } },
    }, "demo");
    expect(manifest.jobs?.x?.bounds).toEqual(["demo:no-files", "other:bound"]);
  });

  it("still names the replacement for a job in the retired shape", () => {
    expect(error({ sweep: { description: "Test job", command: "bash", interval: 300 } })).toMatch(/replaced by `schedules:`/);
  });
});
