#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareEntry } from "./entry.js";
if (process.env.BARRY_TIMING === "1") performance.mark("bin:start");
process.env.BARRY_TIMING_HOOK = "1";
process.env.BARRY_CLI_ENTRY = fileURLToPath(import.meta.url);
const selected = await prepareEntry(fileURLToPath(new URL("../../", import.meta.url)), "barry-hook");
if (selected.entry === "bundle") await import(pathToFileURL(selected.path).href);
else {
  await import("../src/lib/timing.ts");
  await import("../src/hooks/hook-dispatch.ts");
}
