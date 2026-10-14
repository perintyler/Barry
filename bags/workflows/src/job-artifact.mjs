// Self-contained artifact: no imports, ambient clocks, credentials or owner access.
// Kept apart from builtin-artifact.mjs: an owner pins every artifact file by digest,
// so changing that file would refuse to start an owner that already ran echo.
export const definitions = [{
  // One step that runs one bag job on whichever worker may take it. The owner
  // checked the input against the job's contract before this run existed.
  type: "job", version: "1",
  *run(input) {
    return yield { kind: "activity", type: input.job, input: input.input, ...(input.attemptTimeoutMs ? { attemptTimeoutMs: input.attemptTimeoutMs } : {}), ...(input.placement ? { placement: input.placement } : {}) };
  },
}];
