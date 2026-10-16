import { CliError } from "../lib/cli-error.js";
import { parseBagFlagTokens } from "../sessions/prepare.js";
import { runQuery } from "../sdk.js";

export interface PromptCommandOptions {
  prompt: string;
  maxTurns?: string;
  cwd?: string;
  /**
   * The identity, from `--name`. Commander keys options by the flag's long
   * name, so this field MUST be called `name`.
   */
  name?: string;
  bag?: string;
  bags?: string;
  bound?: string;
  bounds?: string;
  model?: string;
}

export async function promptCommand(options: PromptCommandOptions): Promise<void> {
  const maxTurns = options.maxTurns ? parseInt(options.maxTurns, 10) : undefined;
  const parsedBags = parseBagFlagTokens(options.bag ?? options.bags);
  const rawBounds = (options.bound ?? options.bounds)
    ?.split(",")
    .map((b) => b.trim())
    .filter(Boolean) ?? [];
  const bounds = [...new Set([...rawBounds, ...parsedBags.readBounds])];

  try {
    const { result } = await runQuery({
      prompt: options.prompt,
      maxTurns,
      cwd: options.cwd,
      barry: options.name,
      ...(parsedBags.bags.length > 0 ? { bags: parsedBags.bags } : {}),
      ...(bounds.length > 0 ? { bounds } : {}),
      model: options.model,
    });

    if (!result.trim()) {
      console.error(
        "Query produced no result. The run may have been refused, or ended " +
          "before producing output. Nothing was written and no work was done.",
      );
      throw new CliError("", 1);
    }

    console.log(result);
  } catch (error) {
    if (process.env.BARRY_DEBUG === "1" && error instanceof Error) console.error(error.stack);
    throw new CliError(`Query failed: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}
