#!/usr/bin/env node
// `barry-hook <bag> <event> [index]`: what a harness runs for a bag's hook. It
// re-resolves the hook from the live registry at every firing.
import { register } from "tsx/esm/api";

register();
await import("../src/hooks/hook-dispatch.ts");
