/**
 * Fakes of each subject, for tests that install them with `Barry.use(...)`.
 * Every method a test does not supply refuses loudly, so a test states exactly
 * what it depends on and an unexpected call fails instead of answering empty.
 *
 * ```ts
 * Barry.use(fakeIdentities({ get: async () => identity }));
 * afterEach(() => Barry.reset());
 * ```
 */
import type { Actions, Bags, Events, Identities, Schedules, Services, Sessions, Tracker } from "./subjects.js";

function refuse(method: string): () => never {
  return () => {
    throw new Error(`fake ${method} was called, but this test did not supply it`);
  };
}

export function fakeIdentities(overrides: Partial<Identities> = {}): Identities {
  return {
    name: "identities",
    list: overrides.list ?? refuse("identities.list"),
    get: overrides.get ?? refuse("identities.get"),
    create: overrides.create ?? refuse("identities.create"),
    update: overrides.update ?? refuse("identities.update"),
    remove: overrides.remove ?? refuse("identities.remove"),
    makeDefault: overrides.makeDefault ?? refuse("identities.makeDefault"),
    ...(overrides.bags ? { bags: overrides.bags } : {}),
    ...(overrides.bound ? { bound: overrides.bound } : {}),
    ...(overrides.tools ? { tools: overrides.tools } : {}),
    ...(overrides.selectable ? { selectable: overrides.selectable } : {}),
    bounds: overrides.bounds ?? refuse("identities.bounds"),
    owner: overrides.owner ?? refuse("identities.owner"),
    devices: overrides.devices ?? refuse("identities.devices"),
    revokeDevice: overrides.revokeDevice ?? refuse("identities.revokeDevice"),
  };
}

export function fakeSessions(overrides: Partial<Sessions> = {}): Sessions {
  return {
    name: "sessions",
    list: overrides.list ?? refuse("sessions.list"),
    get: overrides.get ?? refuse("sessions.get"),
    start: overrides.start ?? refuse("sessions.start"),
    update: overrides.update ?? refuse("sessions.update"),
    ...(overrides.bags ? { bags: overrides.bags } : {}),
    ...(overrides.bounds ? { bounds: overrides.bounds } : {}),
    ...(overrides.bound ? { bound: overrides.bound } : {}),
    ...(overrides.tools ? { tools: overrides.tools } : {}),
    ...(overrides.skills ? { skills: overrides.skills } : {}),
    ...(overrides.instructions ? { instructions: overrides.instructions } : {}),
    ...(overrides.actions ? { actions: overrides.actions } : {}),
    messages: overrides.messages ?? refuse("sessions.messages"),
    message: overrides.message ?? refuse("sessions.message"),
    listening: overrides.listening ?? refuse("sessions.listening"),
    events: overrides.events ?? refuse("sessions.events"),
    send: overrides.send ?? refuse("sessions.send"),
    end: overrides.end ?? refuse("sessions.end"),
    archive: overrides.archive ?? refuse("sessions.archive"),
    removeAll: overrides.removeAll ?? refuse("sessions.removeAll"),
  };
}

export function fakeActions(overrides: Partial<Actions> = {}): Actions {
  return {
    name: "actions",
    list: overrides.list ?? refuse("actions.list"),
    forSession: overrides.forSession ?? refuse("actions.forSession"),
    run: overrides.run ?? refuse("actions.run"),
    runs: overrides.runs ?? refuse("actions.runs"),
  };
}

export function fakeEvents(overrides: Partial<Events> = {}): Events {
  return {
    name: "events",
    list: overrides.list ?? refuse("events.list"),
    record: overrides.record ?? refuse("events.record"),
  };
}

export function fakeSchedules(overrides: Partial<Schedules> = {}): Schedules {
  return {
    name: "schedules",
    list: overrides.list ?? refuse("schedules.list"),
    scheduler: overrides.scheduler ?? refuse("schedules.scheduler"),
    atSchedules: overrides.atSchedules ?? refuse("schedules.atSchedules"),
    scheduleAt: overrides.scheduleAt ?? refuse("schedules.scheduleAt"),
    cancelAtSchedule: overrides.cancelAtSchedule ?? refuse("schedules.cancelAtSchedule"),
  };
}

export function fakeBags(overrides: Partial<Bags> = {}): Bags {
  return {
    name: "bags",
    list: overrides.list ?? refuse("bags.list"),
    ...(overrides.get ? { get: overrides.get } : {}),
    tools: overrides.tools ?? refuse("bags.tools"),
    ...(overrides.bounds ? { bounds: overrides.bounds } : {}),
    ...(overrides.skills ? { skills: overrides.skills } : {}),
    ...(overrides.instructions ? { instructions: overrides.instructions } : {}),
    ...(overrides.actions ? { actions: overrides.actions } : {}),
    runJob: overrides.runJob ?? refuse("bags.runJob"),
  };
}

export function fakeTracker(overrides: Partial<Tracker> = {}): Tracker {
  return {
    name: "tracker",
    lastChanges: overrides.lastChanges ?? refuse("tracker.lastChanges"),
    changes: overrides.changes ?? refuse("tracker.changes"),
  };
}

export function fakeServices(overrides: Partial<Services> = {}): Services {
  return {
    name: "services",
    list: overrides.list ?? refuse("services.list"),
    get: overrides.get ?? refuse("services.get"),
    start: overrides.start ?? refuse("services.start"),
    stop: overrides.stop ?? refuse("services.stop"),
    restart: overrides.restart ?? refuse("services.restart"),
  };
}

export {describeSessionContract,type SessionContractFixture} from "../sessions/testing/contract.js";
export {acpSessionContractFixture} from "../sessions/testing/acp.js";
