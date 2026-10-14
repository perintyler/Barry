#!/usr/bin/env node
// `barry-service <home> <key>`: what launchd runs for every service. It loads
// the service's prepared definition and execs it with its environment.
import { register } from "tsx/esm/api";

register();
const { main } = await import("../src/services/entry.ts");
main(process.argv.slice(2));
