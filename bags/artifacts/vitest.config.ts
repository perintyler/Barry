import { defineConfig } from "vitest/config";
import base from "../../vitest.base.config.ts";
export default defineConfig({ test: { ...base.test, include: ["src/**/*.test.ts"], fileParallelism: false } });
