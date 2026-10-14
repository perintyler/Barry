import { commentsPlugin } from "./comments-plugin.mjs";
import { join } from "node:path";
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

const JS_FILES = ["**/*.{js,cjs,mjs,jsx}"];
const TS_FILES = ["**/*.{ts,cts,mts,tsx}"];
const TEST_FILES = [
  "**/*.{test,spec}.{js,cjs,mjs,ts,cts,mts,tsx}",
  "**/tests/**/*.{js,cjs,mjs,ts,cts,mts,tsx}",
  "**/__tests__/**/*.{js,cjs,mjs,ts,cts,mts,tsx}",
];

const NO_UNUSED_OPTIONS = {
  argsIgnorePattern: "^_",
  caughtErrorsIgnorePattern: "^_",
  destructuredArrayIgnorePattern: "^_",
  varsIgnorePattern: "^_",
};

const PRODUCTION_FILES = [
  "bags/**/*.{js,cjs,mjs,ts,cts,mts,tsx}",
  "sdk/**/*.{js,cjs,mjs,ts,cts,mts,tsx}",
  "cli/**/*.{js,cjs,mjs,ts,cts,mts,tsx}",
];

const CONSOLE_FILES = [
  // The Workers logger is itself the structured transport to the platform sink.
  "sdk/src/logging/emit-edge.ts",
  // The command line: what it prints is its interface.
  "cli/**/*.{js,cjs,mjs,ts,cts,mts,tsx}",
  ".github/ci/**/*.{js,cjs,mjs,ts,cts,mts,tsx}",
  "**/scripts/**/*.{js,cjs,mjs,ts,cts,mts,tsx}",
  // A script action's stdout is its output, which Barry reads as the result.
  "bags/*/actions/*/*.{js,cjs,mjs,ts,cts,mts,tsx}",
  "**/cli.{js,cjs,mjs,ts,cts,mts,tsx}",
  "**/qa/**/*.{js,cjs,mjs,ts,cts,mts,tsx}",
  "**/examples/**/*.{js,cjs,mjs,ts,cts,mts,tsx}",
  "**/{build,cli}.{js,cjs,mjs,ts,cts,mts,tsx}",
  ...TEST_FILES,
];

const UNTYPED_TS_FILES = [
  "**/*.d.ts",
  "**/*.d.mts",
  "**/*.{config,config.*}.{ts,cts,mts}",
  "**/{vite,vitest,playwright,svelte}.config.{ts,cts,mts}",
  // The shared vitest setup beside vitest.base.config.ts, which no package's
  // tsconfig includes.
  "vitest.*.ts",
  "vitest.base.config.ts",
  "comments-plugin.mjs",
  "comments-plugin.test.mjs",
  ".github/ci/**/*.{ts,cts,mts}",
  "**/scripts/**/*.{ts,cts,mts}",
  "**/qa/**/*.{ts,cts,mts}",
  "**/skills/**/scripts/**/*.{ts,cts,mts}",
  // knip's own config, at the root where no package's tsconfig reaches.
  "knip.ts",
];

export default defineConfig([
  globalIgnores(
    [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/.svelte-kit/**",
      "**/.build/**",
      "**/coverage/**",
      "**/*.min.js",
      "**/vendor/**",
      "**/public/vendor/**",
      "**/.barry/**",
      "**/*.generated.*",
      "**/generated/**",
      "**/qa/fixtures/**",
      "**/__tests__/fixtures/**",
      ".skills/**",
      ".claude/**",
      // Feature worktrees checked out inside the repo. Their files are not in
      // this checkout's tsconfig projects, so the typed rules cannot parse
      // them; a worktree is linted in its own tree.
      ".worktrees/**",
      // `pnpm dev`'s contributor instance, which holds its sessions' worktrees.
      ".barry-dev/**",
      // A local Python virtualenv. Gitignored, but eslint walks the tree
      // rather than reading .gitignore, so thousands of vendored
      // site-packages files reach the linter. knip needed the same entry for
      // the same reason.
      "venv/**",
      // The review-resolution plan tree: dated working records, not project
      // code. Its classifier probe imports by absolute path from the review
      // container, so no tsconfig project can parse it. knip needed the same
      // entry for the same reason.
      "plans/**",
    ],
    "Generated, vendored, and deliberately broken code",
  ),

  {
    name: "Barry lint hygiene",
    linterOptions: {
      reportUnusedDisableDirectives: "error",
      reportUnusedInlineConfigs: "error",
    },
  },

  {
    name: "Comments carry what the code cannot",
    files: [...JS_FILES, ...TS_FILES],
    plugins: { comments: commentsPlugin },
    rules: {
      "comments/no-banner-comment": "error",
    },
  },

  {
    name: "JavaScript correctness",
    files: JS_FILES,
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-unused-vars": ["error", NO_UNUSED_OPTIONS],
    },
  },

  {
    name: "TypeScript correctness",
    files: TS_FILES,
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
    ],
    rules: {
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-undef": "off",
      "no-unused-vars": "off",
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSAsExpression > TSAsExpression > TSUnknownKeyword",
          message:
            "Double assertion through `unknown` erases all type safety. Model the type, validate at the boundary, or use a documented helper.",
        },
      ],
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          minimumDescriptionLength: 10,
          "ts-check": false,
          "ts-expect-error": "allow-with-description",
          "ts-ignore": "allow-with-description",
          "ts-nocheck": true,
        },
      ],
      "@typescript-eslint/no-unused-vars": ["error", NO_UNUSED_OPTIONS],
    },
  },

  {
    name: "TypeScript outside application projects",
    files: UNTYPED_TS_FILES,
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      parserOptions: {
        project: false,
        projectService: false,
      },
    },
  },

  {
    name: "Typed files outside their runtime project",
    files: [
      ...TEST_FILES,
      "cli/test/**/*.ts",
    ],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        projectService: false,
        tsconfigRootDir: join(import.meta.dirname, ".."),
      },
    },
  },

  // No `svelte.configs.recommended`. There is no Svelte in this repo -- zero
  // tracked .svelte files, and the only one on disk is under .barry/archive/,
  // which this config ignores. The plugin therefore linted nothing, by the same
  // argument lint.yml makes for the swiftlint job it dropped: a linter over an
  // empty set exits 0 and reports green forever.
  //
  // It was not free. eslint-plugin-svelte was the sole root of `svelte`, which
  // was the sole root of devalue@5.8.1 -- GHSA-9rgm-9g3h-6x36, the only
  // advisory failing `pnpm security:dependencies`. Upgrading the plugin would
  // not have helped: svelte is a peer dependency, so the vulnerable version
  // still resolves. Removing the one thing that pulled it in fixes the advisory
  // without an allowlist entry or an upstream wait.
  {
    name: "External TypeScript boundaries",
    files: [
      "bags/filesystem/**/*.ts",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
    },
  },

  {
    name: "Test assertions",
    files: TEST_FILES,
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },

  {
    name: "Intentional control-character parsers",
    files: [
      "cli/test/run-cli.ts",
    ],
    rules: {
      "no-control-regex": "off",
    },
  },

  {
    name: "Embedded language patterns",
    files: [
      "bags/sessions/api/src/session-changes-page.ts",
    ],
    rules: {
      "no-useless-escape": "off",
    },
  },

  {
    name: "Node environment",
    files: [
      "sdk/**/*.{js,cjs,mjs}",
      "cli/**/*.{js,cjs,mjs}",
      ".github/ci/**/*.{js,cjs,mjs}",
      "**/scripts/**/*.{js,cjs,mjs}",
      "**/{build,cli}.{js,cjs,mjs}",
      "**/qa/**/*.{js,cjs,mjs}",
      "**/*.{config,config.*}.{js,cjs,mjs}",
      "**/{vite,vitest,playwright,svelte}.config.{js,cjs,mjs}",
      ...TEST_FILES,
    ],
    languageOptions: {
      globals: globals.node,
    },
  },

  {
    name: "Browser environment",
    files: [
      "bags/**/web/**/*.{js,cjs,mjs}",
      // The artifact renderers run in the viewer's page, not in node.
      "bags/artifacts/src/rendering/**/*.{js,cjs,mjs}",
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },

  {
    name: "Test environment",
    files: TEST_FILES,
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },

  {
    name: "Production console policy",
    files: PRODUCTION_FILES,
    rules: {
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },

  {
    name: "Library diagnostics use structured transports",
    files: ["sdk/src/**/*.{js,cjs,mjs,ts,cts,mts,tsx}", "bags/**/src/**/*.{js,cjs,mjs,ts,cts,mts,tsx}", "bags/*/hooks/**/*.{js,cjs,mjs,ts,cts,mts,tsx}"],
    ignores: [...TEST_FILES, "**/scripts/**", "**/qa/**", "**/examples/**", "bags/sessions/src/bookkeeping.ts", "bags/sessions/src/reaper.ts", "bags/workflows/src/preview.ts"],
    rules: { "no-console": ["error", {}] },
  },

  {
    name: "Console output is the interface",
    files: CONSOLE_FILES,
    rules: {
      "no-console": "off",
    },
  },
]);
