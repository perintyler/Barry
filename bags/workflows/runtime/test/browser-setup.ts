/** Browser fixtures invoke this composition root with a disposable BARRY_HOME. */
import { Barry } from "@barry-rocks/sdk";
import { identities } from "@barry-rocks/identities-bag";
Barry.use(identities);
process.exit(0);
