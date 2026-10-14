import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Barry, type Caller } from "@barry-rocks/sdk";
import { fakeServices } from "@barry-rocks/sdk/testing";
const lookup = vi.hoisted(() => vi.fn());
const partitions = vi.hoisted(() => vi.fn());
vi.mock("@barry-rocks/sdk/stores", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/stores")>(),
  sessionIdentity: lookup,
}));
vi.mock("@barry-rocks/sdk/internal/nodes", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/nodes")>(),
  readLocalIdentities: partitions,
}));
import { servicesList, servicesStatus, servicesRestart } from "./tools.js";
const list = vi.fn(async (_caller: Caller) => []);
const get = vi.fn(async () => ({ key: "fixture.api" }) as never);
const restart = vi.fn(async () => ({ key: "fixture.api" }) as never);
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("BARRY_SESSION_ID", ""); lookup.mockReturnValue("partition-bux");
  partitions.mockReturnValue(new Map([["partition-bux", 7]]));
  Barry.use(fakeServices({ list, get, restart }));
});
afterEach(() => { Barry.reset(); vi.unstubAllEnvs(); });
it("passes the context session ahead of the environment without a bag", async () => {
  vi.stubEnv("BARRY_SESSION_ID", "environment-session");
  const context = { secrets: {}, sessionId: "context-session" };
  await servicesList.handler({}, context);
  await servicesStatus.handler({ service: "fixture.api" }, context);
  await servicesRestart.handler({ service: "fixture.api" }, context);
  const caller = { kind: "session", identity: 7, sessionId: "context-session" };
  expect(list).toHaveBeenCalledWith(caller); expect(get).toHaveBeenCalledWith("fixture.api", caller); expect(restart).toHaveBeenCalledWith("fixture.api", caller);
});
it("uses the environment session when there is no context", async () => {
  vi.stubEnv("BARRY_SESSION_ID", "environment-session"); await servicesRestart.handler({ service: "fixture.api" });
  expect(restart).toHaveBeenCalledWith("fixture.api", { kind: "session", identity: 7, sessionId: "environment-session" });
});
it("uses the ambient caller for anonymous CLI tools", async () => {
  await servicesList.handler({}); await servicesStatus.handler({ service: "fixture.api" }); await servicesRestart.handler({ service: "fixture.api" });
  expect(list).toHaveBeenCalledWith({ kind: "owner" }); expect(get).toHaveBeenCalledWith("fixture.api", { kind: "owner" }); expect(restart).toHaveBeenCalledWith("fixture.api", { kind: "owner" });
  expect(lookup).not.toHaveBeenCalled();
});
it("allows ambient reads but refuses writes for an unidentified session", async () => {
  lookup.mockReturnValue(undefined); Barry.useCaller(() => ({ kind: "owner", actorId: 4 }));
  const context = { secrets: {}, sessionId: "unknown" };
  await servicesList.handler({}, context); await servicesStatus.handler({ service: "fixture.api" }, context);
  expect(list).toHaveBeenCalledWith({ kind: "owner", actorId: 4 });
  await expect(servicesRestart.handler({ service: "fixture.api" }, context)).rejects.toMatchObject({ reason: "forbidden" }); expect(restart).not.toHaveBeenCalled();
});
it("refuses writes for a session whose partition names no local identity", async () => {
  partitions.mockReturnValue(new Map());
  const context = { secrets: {}, sessionId: "orphan" };
  await servicesList.handler({}, context);
  expect(list).toHaveBeenCalledWith({ kind: "owner" });
  await expect(servicesRestart.handler({ service: "fixture.api" }, context)).rejects.toMatchObject({ reason: "forbidden" }); expect(restart).not.toHaveBeenCalled();
});
