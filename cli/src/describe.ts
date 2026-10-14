/**
 * `barry __describe`: the command surface as JSON, for generated reference
 * docs (the barry-guide bag's CLI reference is built from it).
 *
 * It walks the program after `applyCommandScope`, so `barry __describe`
 * describes the system commands and `<identity> __describe` the persona
 * commands, exactly as each scope registers them. Hidden commands and options
 * are left out, as `--help` leaves them out. Bag groups are marked `bagGroup`
 * because they depend on what is installed, not on the CLI itself.
 *
 * It runs before `parse()` and before the preAction hook, so it starts no
 * services, opens no store, and needs no identity to be resolvable beyond the
 * scope the process was started in.
 */
import type { Argument, Command, Option } from "commander";

export interface DescribedArgument {
  name: string;
  description: string;
  required: boolean;
  variadic: boolean;
  defaultValue?: unknown;
  choices?: readonly string[];
}

export interface DescribedOption {
  flags: string;
  long?: string;
  short?: string;
  description: string;
  /** The option takes a value: `<value>` (required) or `[value]` (optional). */
  takesValue: boolean;
  valueOptional: boolean;
  /** The option itself must be given. */
  mandatory: boolean;
  negate: boolean;
  variadic: boolean;
  defaultValue?: unknown;
  choices?: readonly string[];
  env?: string;
}

export interface DescribedCommand {
  name: string;
  aliases: string[];
  description: string;
  usage: string;
  arguments: DescribedArgument[];
  options: DescribedOption[];
  commands: DescribedCommand[];
  bagGroup?: true;
}

export interface DescribedProgram {
  version: 1;
  scope: "system" | "identity";
  program: DescribedCommand;
}

type Hideable = { _hidden?: boolean; hidden?: boolean };

function describeArgument(argument: Argument): DescribedArgument {
  return {
    name: argument.name(),
    description: argument.description,
    required: argument.required,
    variadic: argument.variadic,
    ...(argument.defaultValue !== undefined && { defaultValue: argument.defaultValue }),
    ...(argument.argChoices && { choices: argument.argChoices }),
  };
}

function describeOption(option: Option): DescribedOption {
  return {
    flags: option.flags,
    ...(option.long && { long: option.long }),
    ...(option.short && { short: option.short }),
    description: option.description,
    takesValue: option.required || option.optional,
    valueOptional: option.optional,
    mandatory: option.mandatory,
    negate: option.negate,
    variadic: option.variadic,
    ...(option.defaultValue !== undefined && { defaultValue: option.defaultValue }),
    ...(option.argChoices && { choices: option.argChoices }),
    ...(option.envVar && { env: option.envVar }),
  };
}

function describeCommand(command: Command): DescribedCommand {
  const visible = command.commands.filter((sub) => !(sub as Command & Hideable)._hidden && sub.name() !== "help");
  return {
    name: command.name(),
    aliases: command.aliases(),
    description: command.description(),
    usage: command.usage(),
    arguments: command.registeredArguments.map(describeArgument),
    options: command.options.filter((option) => !option.hidden).map(describeOption),
    commands: visible.map(describeCommand),
  };
}

export function describeProgram(
  program: Command,
  scope: "system" | "identity",
  bagGroups: Iterable<string>,
): DescribedProgram {
  const groups = new Set(bagGroups);
  const described = describeCommand(program);
  for (const command of described.commands) if (groups.has(command.name)) command.bagGroup = true;
  return { version: 1, scope, program: described };
}
