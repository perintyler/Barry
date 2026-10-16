import { isIdentityCommand } from "../target.js";

let knownCommands: string[] = [];
export function setKnownCommands(commands: string[]): void {
  knownCommands = commands;
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

export function checkKnownCommand(first: string): void {
  if (!first || first.startsWith("-") || !/^[a-z][\w-]*$/i.test(first)) return;
  if (knownCommands.includes(first)) return;

  if (isIdentityCommand(first)) {
    console.error(`Error: "${first}" is an identity command, not a system command.\n`);
    console.error(`Barry operates through identity personas. Run the command under an identity:`);
    console.error(`  <identity> ${process.argv.slice(2).join(" ")}`);
    console.error(`\nOr specify an identity explicitly:`);
    console.error(`  barry --identity <identity> ${process.argv.slice(2).join(" ")}`);
    console.error(`\nRun "barry identity list" to see your installed identities.`);
    process.exit(1);
  }

  const close = knownCommands.filter((cmd) => levenshtein(first, cmd) <= 2 && first !== cmd);
  if (close.length > 0) {
    console.error(`Unknown command: ${first}`);
    console.error(`Did you mean: ${close.join(", ")}?`);
    process.exit(1);
  }
  console.error(`Unknown command: ${first}`);
  console.error(`Run "barry --help" for available commands.`);
  process.exit(1);
}

