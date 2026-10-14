import { configDefaults, defineConfig } from "vitest/config";
import base from "../../vitest.base.config.ts";

export default defineConfig({
  test: {
    // The base's scratch instance home, so nothing here can write into the
    // real one; vitest's own include, since these suites live beside their code.
    ...base.test,
    include: configDefaults.include,
    exclude: ["**/node_modules/**"],
  },
});
