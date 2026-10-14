import type { Command } from "commander";
import type { InstallationOwnerRecord, InstallationOwnerSelection } from "@barry-rocks/identities-bag";

export interface OwnerCommandDeps {
  owner(): Promise<{ current(): InstallationOwnerRecord | null; bind(selection: InstallationOwnerSelection): InstallationOwnerRecord }>;
  users(): Promise<readonly { id: number; token: string; name: string }[]>;
  interactive: boolean;
  confirm(message: string): Promise<boolean>;
  write(line: string): void;
}
const defaults: OwnerCommandDeps = {
  async owner() { return (await import("@barry-rocks/identities-bag")).owner.installation(); },
  async users() { return (await import("@barry-rocks/identities-bag")).owner.users.list(); },
  get interactive() { return Boolean(process.stdin.isTTY && process.stdout.isTTY); },
  async confirm(message) { return (await import("@inquirer/prompts")).confirm({ message, default: false }); },
  write: line => console.log(line),
};

export async function ownerCommand(deps: OwnerCommandDeps, id?: string, options: { yes?: boolean; json?: boolean } = {}): Promise<void> {
  if (id !== undefined && (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) throw new Error("Owner must be a positive user actor ID");
  if (id !== undefined && !deps.interactive && !options.yes) throw new Error("Unattended owner selection requires --yes");
  const store = await deps.owner();
  const owner = store.current();
  if (id === undefined) {
    const users = owner ? [] : (await deps.users()).map(user => ({ id: user.id, name: user.name }));
    if (options.json) { deps.write(JSON.stringify({ owner, users }, null, 2)); return; }
    if (owner) { deps.write(`Installation owner: ${owner.actorId} ${JSON.stringify(owner.name)}`); return; }
    deps.write("No installation owner is bound. Select a user with barry owner <actor-id>.");
    for (const user of users) deps.write(`  ${user.id} ${JSON.stringify(user.name)}`);
    return;
  }
  const user = (await deps.users()).find(user => user.id === Number(id));
  if (!user) throw new Error("Selected user is unavailable");
  if (owner && owner.actorId !== user.id) throw new Error("Installation owner is already bound to another user");
  if (!options.yes && !await deps.confirm(`Bind installation ownership to ${user.id} ${JSON.stringify(user.name)}?`)) { deps.write("No changes made."); return; }
  const bound = store.bind({ actorId: user.id, actorToken: user.token });
  deps.write(options.json ? JSON.stringify({ owner: bound }, null, 2) : `Installation owner: ${bound.actorId} ${JSON.stringify(bound.name)}`);
}

export function registerOwner(program: Command, deps: OwnerCommandDeps = defaults): void {
  program.command("owner [actor-id]").description("Show or bind the local installation's user owner")
    .option("--yes", "Bind the selected user without an interactive confirmation")
    .option("--json", "Print owner metadata as JSON")
    .action((id: string | undefined, options: { yes?: boolean; json?: boolean }) => ownerCommand(deps, id, options));
}
