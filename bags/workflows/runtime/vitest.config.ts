import { mergeConfig } from "vitest/config";
import base from "../../../vitest.base.config.ts";
export default mergeConfig(base, { test: { include: ["src/**/*.test.ts"] } });
