/**
 * Scaffolders for the things a bag contains: actions, instructions, bounds.
 *
 * Bags get their own module (scaffold.ts) because a bag is a directory tree with
 * a package.json and a build; these three are a file or two inside an existing
 * bag. What they share is the rule that scaffolding never overwrites — a
 * generator that clobbers is a generator nobody runs twice.
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { parseDocument } from "yaml";
import { buildActionYaml } from "@barry-rocks/sdk/internal/actions";

export interface ScaffoldResult {
  /** Files written, absolute. */
  files: string[];
  /** Human-readable next step, when there is one worth saying. */
  hint?: string;
}

function refuseExisting(path: string, what: string): void {
  if (existsSync(path)) {
    throw new Error(`${what} already exists: ${path}`);
  }
}

/**
 * Scaffold an action directory inside a bag.
 *
 * The generated prompt is deliberately a filled-in skeleton rather than a
 * `TODO`: an action whose prompt still says TODO reads as finished to the
 * registry and gets offered to agents, so the placeholder must be obviously
 * unfinished when an agent reads it, not just when a human does.
 */
export function scaffoldActionDir(options: {
  bagDir: string;
  name: string;
  description?: string;
  /** Write into `skills/<name>/` instead of `actions/<name>/`. */
  intoSkills?: boolean;
}): ScaffoldResult {
  const { bagDir, name, description, intoSkills } = options;

  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`Action name must be kebab-case: ${name}`);
  }

  const parent = join(bagDir, intoSkills ? "skills" : "actions");
  const dir = join(parent, name);
  refuseExisting(dir, "Action");

  mkdirSync(dir, { recursive: true });

  const yaml = buildActionYaml({
    name,
    description: description || `TODO: describe ${name} — this text is what agents search.`,
    prompt: [
      `# ${name}`,
      "",
      "TODO: replace this body with the procedure. An agent follows it literally,",
      "so write the steps, not a summary of them.",
      "",
      "Scripts this action ships are referenced as ${ACTION_DIR}/scripts/<file>,",
      "which resolves to an absolute path when the action begins.",
    ].join("\n"),
  });

  const file = join(dir, "action.yaml");
  writeFileSync(file, yaml, "utf-8");

  return {
    files: [file],
    hint: `Edit ${file}, then run it with: barry action run ${name}`,
  };
}

/**
 * Scaffold an instruction file inside a bag.
 *
 * Defaults to on-demand for the reason bags.md gives: always-on prose is a tax
 * on every turn of every session, so it should be a deliberate choice.
 */
export function scaffoldInstruction(options: {
  bagDir: string;
  name: string;
  description?: string;
  mode?: "always" | "on-demand";
}): ScaffoldResult {
  const { bagDir, name, description, mode = "on-demand" } = options;

  const dir = join(bagDir, "instructions");
  const file = join(dir, `${name}.md`);
  refuseExisting(file, "Instruction");

  mkdirSync(dir, { recursive: true });

  const body = [
    "---",
    `name: ${name}`,
    `description: ${description || `TODO: describe ${name}`}`,
    `mode: ${mode}`,
    "---",
    "",
    "TODO: replace with the standing guidance. This is prose the model reads as",
    "context — how this Barry does something — not a procedure to run.",
    "",
  ].join("\n");

  writeFileSync(file, body, "utf-8");

  return {
    files: [file],
    hint: mode === "always"
      ? `${file} is always-on — it costs tokens on every turn of every session.`
      : `Edit ${file}. Agents pull it in with: get_instructions ${name}`,
  };
}

/**
 * Add a bound to an existing bag.yaml.
 *
 * Unlike the other two this EDITS a file rather than writing a new one, so it
 * goes through the YAML *document* tree rather than parse-then-stringify.
 * Round-tripping through a plain object discards every comment, and the bag
 * scaffolder itself ships a commented-out `dependencies:` example — so the
 * naive version destroyed documentation on the very files it was most likely
 * to be run against.
 */
export function scaffoldBound(options: {
  bagDir: string;
  name: string;
  description?: string;
}): ScaffoldResult {
  const { bagDir, name, description } = options;

  const file = join(bagDir, "bag.yaml");
  if (!existsSync(file)) throw new Error(`No bag.yaml in ${bagDir}`);

  const doc = parseDocument(readFileSync(file, "utf-8"));

  if (doc.hasIn(["bounds", name])) {
    throw new Error(`Bound "${name}" already exists in ${file}`);
  }

  const rawBagName = doc.get("name");
  const bagName = typeof rawBagName === "string" && rawBagName.length > 0 ? rawBagName : "bag";

  doc.setIn(["bounds", name], doc.createNode({
    description: description || `TODO: describe the ${name} bound`,
    tools: {
      deny: [`${bagName}:write`],
    },
  }));

  writeFileSync(file, doc.toString({ lineWidth: 120 }), "utf-8");

  return {
    files: [file],
    hint: `Bound "${name}" added to ${file}. Reference it as "${bagName}:${name}".`,
  };
}
