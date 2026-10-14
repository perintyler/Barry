import { build } from "esbuild";
import { writeFileSync, unlinkSync } from "node:fs";
import { isAbsolute } from "node:path";
import { inspectArtifact } from "./artifacts.js";

/** Bundles a closed graph, then validates it without importing application code. */
export async function buildArtifact(options: { entry: string; destination: string; type: string; version: string; workflow?: boolean }) {
  if (!isAbsolute(options.entry) || !isAbsolute(options.destination)) throw new Error("artifact paths must be absolute");
  const result = await build({ entryPoints: [options.entry], bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", metafile: true, sourcemap: false });
  if (Object.values(result.metafile.outputs).some(output => output.imports.length)) throw new Error("artifact has external imports");
  if (result.outputFiles.length !== 1) throw new Error("artifact must have exactly one output");
  writeFileSync(options.destination, result.outputFiles[0].contents, { flag: "wx", mode: 0o600 });
  try { return inspectArtifact(options.destination, options.type, options.version, options.workflow ?? true); }
  catch (error) { unlinkSync(options.destination); throw error; }
}
