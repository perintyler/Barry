#!/usr/bin/env node
import { register } from "tsx/esm/api";
register();
const { main } = await import("../src/releases/build.ts");
try { await main(process.argv.slice(2)); }
catch (error) {
  console.error(String(error instanceof Error ? error.message : error).replace(/\s*\n\s*/g, "; "));
  process.exitCode = 1;
}
