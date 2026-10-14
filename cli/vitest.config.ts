import { defineConfig } from "vitest/config";
import base from "../vitest.base.config.ts";
export default defineConfig({ test: { ...base.test, setupFiles: ["./test/setup.ts"], include: ["src/**/*.test.ts", "test/**/*.test.ts"], testTimeout: 60000 } });
