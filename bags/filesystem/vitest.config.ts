import { configDefaults, defineConfig } from "vitest/config";
import base from "../../vitest.base.config.ts";

// `locks` and `tracker` are their own workspace packages with their own test
// scripts — without this exclude their suites run twice in CI, once here and
// once in their own package. Inherited from the the system tools config, which
// excluded the same two sub-bags before they moved here.
export default defineConfig({
  test: {
    // The base's scratch instance home, so nothing here can write into the
    // real one; vitest's own include, since these suites live beside their code.
    ...base.test,
    include: configDefaults.include,
    exclude: ["**/node_modules/**", "locks/**", "tracker/**"],
  },
});
