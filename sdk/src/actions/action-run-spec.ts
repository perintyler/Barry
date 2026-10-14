/**
 * Run actions retain declarative entry metadata until launch, sharing the
 * service/script runtime resolver. Explicit native command/args and packaged
 * shell/executable shorthand remain direct process launches.
 */

import { isAbsolute, normalize, resolve, sep } from "path";
import { z } from "zod";
import { LaunchShape, hasOneLaunch, normalizeLaunch, resolveLaunch } from "../services/launch.js";
import { interpreterFor } from "./script-interpreter.js";
import { resolveLaunchdItem } from "../services/launchd-items.js";

export const ActionRunSchema = z.union([
  z.string().min(1),
  z
    .object({
      ...LaunchShape,
      /** Relative to the action's directory. Defaults to that directory. */
      "working-directory": z.string().min(1).optional(),
    })
    .strict().refine(hasOneLaunch, { message: "choose exactly one launch form: entry or command" }),
]);

export type ActionRunField = z.infer<typeof ActionRunSchema>;

/** A `run:` block, normalized. Paths are still relative to the action directory. */
export interface ActionRunSpec {
  entry?: string;
  command: string;
  args: string[];
  workingDirectory?: string;
}

/** The absolute invocation a spec resolves to for one action directory. */
export interface ActionRunInvocation {
  command: string;
  args: string[];
  cwd: string;
}

function escapesDir(rel: string): boolean {
  const normalized = normalize(rel);
  return isAbsolute(rel) || normalized === ".." || normalized.startsWith(`..${sep}`);
}

/**
 * Normalize a parsed `run:` field. Throws on a script path that leaves the
 * action directory — an action is its directory, and a script reaching outside
 * it runs code the action's packaging never shipped.
 */
export function normalizeActionRun(field: ActionRunField, label: string): ActionRunSpec {
  if (typeof field !== "string") {
    return {
      ...normalizeLaunch(field),
      args: field.args ?? [],
      ...(field["working-directory"] ? { workingDirectory: field["working-directory"] } : {}),
    };
  }
  if (escapesDir(field)) {
    throw new Error(`Invalid action ${label}: run path must be relative to the action dir: ${field}`);
  }
  if (/\.(?:[cm]?[jt]s|tsx)$/.test(field)) {
    return { ...normalizeLaunch({ entry: field }), args: [] };
  }
  const interpreter = interpreterFor(field);
  // No known extension: the file is its own program. `./` keeps spawn from
  // searching PATH for a bare name that happens to match a binary.
  return interpreter
    ? { command: interpreter, args: [field] }
    : { command: `./${normalize(field)}`, args: [] };
}

/**
 * Resolve a spec against the action's directory, holding every relative path
 * inside it. Same containment rule as bag services and jobs (launchd-items):
 * absolute paths name a host binary on purpose and are left alone.
 *
 * Throws rather than returning null: the executor records the message on the
 * run, and "escaped the action dir" must read differently from "exited 1".
 */
export function resolveActionRun(actionDir: string, spec: ActionRunSpec): ActionRunInvocation {
  const launch = resolveLaunch(spec, actionDir);
  const { item, escaped } = resolveLaunchdItem(actionDir, {
    name: launch.command,
    args: launch.args,
    ...(spec.workingDirectory ? { workingDirectory: spec.workingDirectory } : {}),
  });
  const commandIsRelativePath = !isAbsolute(launch.command) && launch.command.includes("/");
  if (commandIsRelativePath && escapesDir(launch.command)) escaped.push(launch.command);
  if (!item || escaped.length > 0) {
    throw new Error(`run: path(s) escape the action directory: ${escaped.join(", ")}`);
  }
  return {
    command: commandIsRelativePath ? resolve(actionDir, launch.command) : launch.command,
    args: item.args ?? [],
    // resolveLaunchdItem always fills this (defaulting to the action dir).
    cwd: item.workingDirectory ?? resolve(actionDir),
  };
}
