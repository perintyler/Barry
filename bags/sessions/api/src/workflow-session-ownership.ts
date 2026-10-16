import { assertInteractiveSession } from "@barry-rocks/sessions-bag/store/workflow-ownership";
import { getSessionsSqlite } from "@barry-rocks/sessions-bag/store/sessions-db";
import { sessionIdentity } from "@barry-rocks/sdk/stores";
import { currentStoreContext, withStoreContext } from "@barry-rocks/sdk/internal/stores";

/** All interactive paths share canonical membership; a supplied workflow turn ID is no bypass. */
export function assertInteractiveDestination(sessionId: string): void {
  const check = () => assertInteractiveSession(getSessionsSqlite(), sessionId);
  // Match the Sessions client routing boundary. Explicit partition contexts
  // already select the destination; background callers resolve its committed row.
  if (currentStoreContext()?.identity) return check();
  const identity = sessionIdentity(sessionId);
  if (identity) return withStoreContext({ identity }, check);
  check();
}
