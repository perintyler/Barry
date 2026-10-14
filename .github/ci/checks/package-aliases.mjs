import { strict as assert } from "node:assert";
import { classify as legacy } from "@barry-rocks/sessions-bag/process-liveness";
import { classify as canonical } from "../../../bags/sessions/src/process-liveness.ts";

assert.equal(legacy, canonical, "The one-release session-bag alias must reach the canonical implementation");
console.log("Legacy linked session-bag alias reaches the canonical implementation");
