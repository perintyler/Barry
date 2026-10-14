/**
 * Scaffold a new bag directory
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync } from "fs";
import { join, relative, resolve, sep } from "path";
import { installationRoot } from "@barry-rocks/sdk/services";
import { stringify } from "yaml";


export interface ScaffoldOptions {
  name: string;
  description?: string;
  path: string;
  withServer?: boolean;
  /**
   * Both emit a bag against `@barry-rocks/sdk/tools`; they differ in how it is
   * depended on. `local` (default) links into this workspace; `npm` pins a
   * published caret range so the bag resolves in an external author's repo.
   */
  template?: "local" | "npm";
}

export function scaffoldBag(options: ScaffoldOptions): string {
  const { name, description = "", path: bagPath, withServer, template = "local" } = options;

  if (existsSync(bagPath)) {
    throw new Error(`Directory already exists: ${bagPath}`);
  }

  mkdirSync(bagPath, { recursive: true });
  mkdirSync(join(bagPath, "skills"), { recursive: true });

  const manifest: Record<string, unknown> = {
    version: "v0.1",
    name,
    description: description || `${name} bag`,
  };

  if (withServer) {
    manifest.server = {
      entry: "server.ts",
    };
  }

  manifest["mcp-servers"] = {};
  manifest.traits = {};
  manifest.tools = [];

  // Write manifest, with a commented example for host binary dependencies
  const dependenciesExample = [
    "",
    "# Host binaries this bag needs at runtime. Checked on PATH —",
    "# missing binaries warn in `bag show`/`barry pack` and fail fast at MCP connect.",
    "# dependencies:",
    "#   - name: some-cli",
    "#     install: brew install some-cli",
    "#     reason: powers the some_* tools",
    "",
  ].join("\n");
  writeFileSync(
    join(bagPath, "bag.yaml"),
    stringify(manifest, { lineWidth: 120 }) + dependenciesExample,
    "utf-8",
  );

  if (withServer) {
    scaffoldServerFiles(bagPath, name, template);
  }

  return bagPath;
}

/**
 * How the scaffolded bag should depend on @barry-rocks/sdk/bags.
 *
 * `workspace:*` only resolves for a bag inside Barry's pnpm workspace. Most
 * bags live in their own repo, where that specifier cannot resolve at all —
 * so every real external bag had to be hand-edited to a `link:` path before it
 * would install. Emit the form that actually works for where the bag is.
 */
function toolsDependency(bagPath: string): string {
  const repoRoot = installationRoot();
  const inWorkspace = [resolve(bagPath), realpathSync(bagPath)].some(path =>
    [repoRoot, realpathSync(repoRoot)].some(root => path.startsWith(root + sep)));
  if (inWorkspace) return "workspace:*";

  // Relative, not absolute: an absolute link pins the bag to one machine's
  // checkout path, so the repo cannot be cloned elsewhere or shared. A relative
  // path survives both, and is the form that migrates to an npm version range
  // by editing nothing but the range itself.
  const rel = relative(resolve(bagPath), join(repoRoot, "sdk"));
  return `link:${rel.split(sep).join("/")}`;
}

/**
 * How an npm-template bag should depend on @barry-rocks/sdk/bags.
 *
 * Read from the SDK's own manifest rather than hardcoded: a literal drifts the
 * moment the SDK majors, and the scaffolded bag only fails much later, in
 * someone else's repo, at install time.
 */
function npmSdkDependency(): string {
  const packageRoot = join(installationRoot(), "sdk");
  const manifest = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf-8"),
  ) as { name?: string; version?: string };
  if (!manifest.version) {
    throw new Error("sdk/package.json has no version to scaffold against");
  }
  return `^${manifest.version}`;
}

function scaffoldServerFiles(bagPath: string, name: string, template: "local" | "npm"): void {
  const isNpm = template === "npm";
  // Dependency package names and import subpaths differ; choose link or npm range by template.
  // See docs/decisions/0019-cli-checkouts-and-session-selection.md.
  const toolsPackage = "@barry-rocks/sdk";
  const toolsImport = `${toolsPackage}/tools`;

  const pkg: Record<string, unknown> = {
    name: isNpm ? name : `@barry-rocks/${name}-bag`,
    version: isNpm ? "0.1.0" : "1.0.0",
    ...(isNpm ? {} : { private: true }),
    type: "module",
    ...(isNpm ? {
      main: "src/server.ts",
      exports: { ".": "./src/server.ts", "./bag.yaml": "./bag.yaml" },
      publishConfig: {
        main: "dist/server.js",
        exports: { ".": { types: "./dist/server.d.ts", import: "./dist/server.js" }, "./bag.yaml": "./bag.yaml" },
      },
      files: ["dist", "bag.yaml"],
    } : {}),
    ...(isNpm ? { engines: { node: ">=22" } } : {}),
    ...(isNpm ? {
      scripts: { build: "tsc -p tsconfig.build.json", test: "vitest run" },
    } : {}),
    dependencies: {
      [toolsPackage]: isNpm ? npmSdkDependency() : toolsDependency(bagPath),
    },
    ...(isNpm ? { peerDependencies: { zod: "^3.25.0" } } : {}),
    devDependencies: {
      "@types/node": "22.15.0",
      ...(isNpm ? {} : { tsx: "4.21.0" }),
      typescript: "5.9.3",
      ...(isNpm ? { vitest: "4.1.0" } : {}),
      zod: "3.25.76",
    },
  };
  writeFileSync(join(bagPath, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf-8");

  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
    },
    include: isNpm ? ["src/**/*"] : ["*.ts"],
  };
  writeFileSync(join(bagPath, "tsconfig.json"), JSON.stringify(tsconfig, null, 2) + "\n", "utf-8");

  if (isNpm) {
    const tsconfigBuild = {
      extends: "./tsconfig.json",
      compilerOptions: {
        noEmit: false,
        declaration: true,
        declarationMap: true,
        sourceMap: true,
        outDir: "dist",
        rootDir: "src",
      },
      include: ["src/**/*"],
    };
    writeFileSync(join(bagPath, "tsconfig.build.json"), JSON.stringify(tsconfigBuild, null, 2) + "\n", "utf-8");
    mkdirSync(join(bagPath, "src"), { recursive: true });
  }

  // server.ts — stdout is reserved for MCP protocol, do not write to it
  const serverTs = `import { defineTool } from "${toolsImport}";
import { startBagServer } from "${toolsPackage}/mcp";
import { z } from "zod";

const hello = defineTool({
  namespace: "${name}",
  access: "read",
  name: "hello",
  description: "Say hello",
  schema: { name: z.string().describe("Name to greet") },
  handler: async ({ name }) => \`Hello, \${name}!\`,
});

// stdout is reserved for MCP — use stderr for logging
startBagServer({ name: "${name}", tools: [hello] });
`;
  const serverPath = isNpm ? join(bagPath, "src", "server.ts") : join(bagPath, "server.ts");
  writeFileSync(serverPath, serverTs, "utf-8");
}
