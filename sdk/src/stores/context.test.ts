import { expect, it } from "vitest";
import { Barry } from "../index.js";
import { withStoreContext } from "./context.js";
import type { StoreDeclaration } from "./registry.js";

const declaration: StoreDeclaration = { owned_by: "identity", engine: "sqlite", migrations: "./migrations" };
const bags = { artifacts: { stores: { default: declaration } } };

it("resolves a retained bag handle independently for concurrent identities", async () => {
  const artifacts = Barry.bag("artifacts");
  const resolve = async (identity: string) => withStoreContext({ identity, bags, root: "/scratch", node: "desktop" }, async () => {
    await new Promise((done) => setTimeout(done, identity === "alice" ? 20 : 1));
    return artifacts.store();
  });
  const [alice, bob] = await Promise.all([resolve("alice"), resolve("bob")]);
  expect(alice.identity).toBe("alice");
  expect(bob.identity).toBe("bob");
  expect(alice.filepath).toBe("/scratch/identities/alice/artifacts/default.db");
  expect(bob.filepath).toBe("/scratch/identities/bob/artifacts/default.db");
  expect(() => artifacts.store()).toThrow("execution context");
});

it("requires the bag to be bound and does not leak nested scope", () => {
  const artifacts = Barry.bag("artifacts");
  withStoreContext({ identity: "alice", bags, root: "/scratch" }, () => {
    expect(artifacts.store().identity).toBe("alice");
    withStoreContext({ identity: "bob", bags, root: "/scratch" }, () => expect(artifacts.store().identity).toBe("bob"));
    expect(artifacts.store().identity).toBe("alice");
    expect(() => Barry.bag("unbound").store()).toThrow("not bound");
  });
  expect(() => withStoreContext({ identity: "alice" }, () => artifacts.store())).toThrow("not bound");
});
