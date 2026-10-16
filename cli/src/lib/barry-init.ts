let barryInitialized = false;
/** Register the full CLI composition for commands and guest execution. */
export async function ensureBarry(): Promise<void> {
  if (barryInitialized) return;
  const [
    { Barry },
    { identities, bags },
    { sessions },
    { actions },
    { events: eventSubject },
    { schedules },
    { tracker },
    { services },
  ] = await Promise.all([
    import("@barry-rocks/sdk"),
    import("@barry-rocks/identities-bag"),
    import("@barry-rocks/sessions-bag"),
    import("@barry-rocks/actions-bag"),
    import("@barry-rocks/events-bag"),
    import("@barry-rocks/schedules-bag"),
    import("@barry-rocks/tracker-bag"),
    import("@barry-rocks/mcp-bag"),
  ]);
  Barry.use(identities, bags, sessions, actions, eventSubject, schedules, tracker, services);
  barryInitialized = true;
}

let coreInitialized = false;
/** Session selection needs the local identity and session subjects only. */
export async function ensureBarryCore(): Promise<void> {
  if (barryInitialized || coreInitialized) return;
  const [{ Barry }, { identities, bags }, { sessions }] = await Promise.all([
    import("@barry-rocks/sdk"), import("@barry-rocks/identities-bag"), import("@barry-rocks/sessions-bag"),
  ]);
  Barry.use(identities, bags, sessions);
  coreInitialized = true;
}
