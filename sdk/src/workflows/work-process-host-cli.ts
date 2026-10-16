import {
  readProcessWorkHostConfig,
  runProcessWorkHost,
  verifyProcessWorkHostRemoteSetup,
} from "./work-process-host.js";
import { WorkflowError } from "./errors.js";

const stop = new AbortController();
const shutdown = () => stop.abort();
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
const failure = (error: unknown) =>
  JSON.stringify({
    event: "process-work-host-error",
    code: error instanceof WorkflowError ? error.code : "WorkHostUnavailable",
  }) + "\n";

try {
  if (
    process.argv.length !== 4 ||
    (process.argv[2] !== "--config" && process.argv[2] !== "--verify-config")
  ) {
    throw new Error("expected --config <absolute-path> or --verify-config <absolute-path>");
  }
  const config = readProcessWorkHostConfig(process.argv[3]!);
  if (process.argv[2] === "--verify-config") {
    const { lockStore } = verifyProcessWorkHostRemoteSetup(config);
    lockStore?.close();
    process.stdout.write(JSON.stringify({ event: "process-work-host-config-verified" }) + "\n");
  } else {
    await runProcessWorkHost(config, {
      signal: stop.signal,
      onReady: () =>
        process.stdout.write(JSON.stringify({ event: "process-work-host-ready" }) + "\n"),
      onError: error => process.stderr.write(failure(error)),
    });
  }
} catch (error) {
  process.stderr.write(failure(error));
  process.exitCode = 1;
} finally {
  process.off("SIGTERM", shutdown);
  process.off("SIGINT", shutdown);
}
