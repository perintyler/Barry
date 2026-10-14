import { basename, join } from "node:path";
import { barryStoresDir } from "@barry-rocks/sdk/services";
import { interruptedStoreGeneration, recoverStoreGeneration, validatePreparedStoreGeneration } from "@barry-rocks/sdk/internal/stores";
import { switchStoreGeneration, type StoreServices } from "./db-services.js";
import { pruneOlderGenerations } from "./db-prune.js";

export async function dbRecoverCommand(options: { services?: StoreServices } = {}): Promise<void> {
  const root = barryStoresDir(), interrupted = interruptedStoreGeneration(root);
  if (!interrupted) {
    console.log("No store switch was interrupted; nothing to recover. Start any stopped services with `barry up`.");
    return;
  }
  const { id, previousId, state } = interrupted;
  console.log(`The switch from generation ${previousId} to ${id} stopped at "${state}". Finishing it.`);
  const result = await switchStoreGeneration({ command: "Recovery", previous: join(root, "generations", previousId), services: options.services,
    async switch(stopAgain) {
      await stopAgain();
      const recovered = await recoverStoreGeneration({ root, servicesStopped: true,
        // Another terminal can finish a switch while these services stop.
        validate: async directory => { await validatePreparedStoreGeneration(root, basename(directory)); },
      });
      if (!recovered) throw new Error("the interrupted store switch changed before recovery");
      return { ...recovered, directory: join(root, "generations", recovered.state === "active" ? recovered.id : recovered.previousId) };
    },
  });
  if (result.state === "active") {
    console.log(`Finished: generation ${result.id} is active; ${result.previousId} is kept for \`barry db rollback\`.`);
    for (const line of await pruneOlderGenerations(root)) console.log(line);
  } else console.log(`Could not finish (${result.reason}): generation ${result.previousId} stays active.`);
  console.log("Start any services still stopped with `barry up`.");
}
