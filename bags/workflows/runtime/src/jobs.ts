import { bounds } from "@barry-rocks/identities-bag";
import { installationJobs as inventory, type JobInventory } from "@barry-rocks/sdk/internal/workflows";

/** The installed bags' jobs that can run on another machine, with their bounds resolved here. */
export async function installationJobs(): Promise<JobInventory> {
  return inventory(async name => await bounds.get({ name }));
}
