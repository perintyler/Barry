import { expect, it } from "vitest";
import {
  upsertTrait,
  listTraits,
} from "./config/traits.js";
import {
  upsertBound,
  getBoundByName,
} from "./config/bounds.js";
import { closeIdentitiesDb } from "./store/identities-db.js";
import { Identities } from "./store/identities.js";
import { Users } from "./store/users.js";
import { selectTraits, expandTraits } from "@barry-rocks/sdk/internal/traits";
import {
  resolveExecutionContext,
  assertToolAllowed,
} from "@barry-rocks/sdk/bounds";
it("persists a composed identity grant and named bound and resolves it after reopening", async () => {
  await upsertTrait({
    name: "fixture.reader",
    namespaces: ["notes"],
    access: "read",
  });
  await upsertTrait({
    name: "fixture.writer",
    namespaces: ["notes"],
    access: "readwrite",
    includes: ["fixture.reader"],
    boundNames: ["fixture.readonly"],
  });
  await upsertBound({
    name: "fixture.readonly",
    bound: { deniedAccess: ["write"] },
  });
  const user = await Users.create({
    email: "fixture-traits@example.test",
    name: "fixture",
  });
  const stored = await Identities.create({
    actor_id: user.id,
    name: "fixture",
    metadata: { traits: ["fixture.writer"], bags: ["unselected"] },
  });
  closeIdentitiesDb();
  const reopened = await Identities.get(stored.id);
  expect(reopened).toBeDefined();
  const identity = Identities.resolveConfig(reopened!);
  const catalog = Object.fromEntries(
    (await listTraits()).map((trait) => [
      trait.name,
      { ...trait, bound: trait.bound ?? undefined },
    ]),
  );
  const names = expandTraits(selectTraits({ identity: { ...identity, traits: identity.traits.filter(entry => !entry.optional).map(entry => entry.name) } }), catalog);
  const context = await resolveExecutionContext({
    traitNames: names,
    traits: catalog,
    tools: [
      { namespace: "notes", toolName: "read", access: "read" },
      { namespace: "notes", toolName: "write", access: "write" },
    ],
    boundByName: async (name) => (await getBoundByName(name))?.bound,
  });
  expect(() =>
    assertToolAllowed(
      context,
      { namespace: "notes", toolName: "read" },
      "local",
    ),
  ).not.toThrow();
  expect(() =>
    assertToolAllowed(
      context,
      { namespace: "notes", toolName: "write" },
      "local",
    ),
  ).toThrow();
  expect(names).not.toContain("unselected");
});
