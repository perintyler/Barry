import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifest } from "@barry-rocks/sdk/bags";
import {
  filterToolObjects,
  nativeToolDenials,
  nativeToolsTakenBack,
  resolveNativeTools,
} from "@barry-rocks/sdk/bounds";
import { loadAdapters } from "@barry-rocks/sdk/internal/adapters";
import { closeIdentitiesDb } from "../store/identities-db.js";
import {
  Identities,
  resolveIdentityConfig,
  type IdentityMetadata,
  type IdentityRecord,
} from "../store/identities.js";
import { createUser } from "../store/users.js";
import { Barry } from "@barry-rocks/sdk";
import { identities } from "./identities.js";
import { resolve } from "./resolve.js";

let directory: string;
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.BARRY_IDENTITIES_DB;
  directory = mkdtempSync(join(tmpdir(), "bag-bound-roundtrip-"));
  closeIdentitiesDb();
  process.env.BARRY_IDENTITIES_DB = join(directory, "identities.db");
});

afterEach(() => {
  closeIdentitiesDb();
  if (previous === undefined) delete process.env.BARRY_IDENTITIES_DB;
  else process.env.BARRY_IDENTITIES_DB = previous;
  rmSync(directory, { recursive: true, force: true });
});

describe("resolve", () => {
  it.each([
    ["claude", "claude-code", "Bash"],
    ["cursor", "cursor", "Shell"],
    ["codex", "codex", "exec_command"],
    ["opencode", "opencode", "shell"],
  ])(
    "an identity selecting bash:no-bash carries the bash bag's bound into %s launch settings",
    async (folder, id, shell) => {
      const bash = parseManifest(new URL("../../../bash", import.meta.url).pathname)!;
      const manifest = parseManifest(
        new URL(`../../../../adapters/sessions/${folder}`, import.meta.url).pathname,
      )!;
      const user = await createUser({ name: "Reviewer", email: "reviewer@example.test" });
      const identity = await Identities.create({
        actor_id: user.id,
        name: "reviewer",
        metadata: { bounds: ["bash:no-bash"] },
      });

      const bashBag = { name: "bash", manifest: bash };
      const bound = await resolve.bound(identity, {
        bags: [bashBag],
        harness: id,
        defaults: false,
      });

      const inventory = [
        ...new Set(
          Object.values(manifest.bounds ?? {}).flatMap((definition) =>
            nativeToolDenials(definition.bound, id),
          ),
        ),
      ];
      const harness = { id, tools: inventory, bag: { path: "", manifest } };
      const cliDenied = resolveNativeTools({ bound, tools: [] }, harness, "guest").denied;
      const hostedDenied = resolveNativeTools({ bound, tools: [] }, harness, "hosted").denied;
      expect(cliDenied).toContain(shell);
      expect(hostedDenied).toContain(shell);
      expect(nativeToolsTakenBack(bound, harness)).toContain(shell);

      const filtered = filterToolObjects(
        [
          { id: "bash:Bash", namespace: "bash", name: "Bash", access: "write" },
          { id: "bash:BashOutput", namespace: "bash", name: "BashOutput", access: "read" },
          { id: "bash:KillShell", namespace: "bash", name: "KillShell", access: "write" },
          { id: "filesystem:Read", namespace: "filesystem", name: "Read", access: "read" },
        ],
        bound,
      );
      expect(filtered.map((t) => t.name)).toEqual(["Read"]);
    },
  );

  it("composes real installed native tools, restrictions and mode limits", async () => {
    const store = loadAdapters({
      file: join(directory, "adapters.json"),
      registerBag: async () => {},
    });
    const records = await Promise.all(
      ["claude", "pi", "cursor"].map((folder) =>
        store.add(new URL(`../../../../adapters/sessions/${folder}`, import.meta.url).pathname),
      ),
    );
    const bash = parseManifest(new URL("../../../bash", import.meta.url).pathname)!;
    const bashBag = { name: "bash", manifest: bash, optional: true };

    const select = async (harness = "claude-code", selectedBounds: string[] = []) => {
      const bound = await resolve.bound(undefined, {
        bags: [bashBag],
        harness,
        bounds: selectedBounds,
        defaults: false,
        harnesses: records,
      });
      const tools = await resolve.tools(undefined, {
        bags: [bashBag],
        harness,
        mode: "hosted",
        bound,
        defaults: false,
        harnesses: records,
      });
      return { bound, tools };
    };

    const unrestricted = await select("claude-code");
    expect(unrestricted.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["Read", "Glob", "Grep", "Bash"]),
    );
    expect(
      unrestricted.tools.every((tool) => tool.bag === null && tool.namespace === "claude-code"),
    ).toBe(true);

    const noNetwork = await select("claude-code", ["no-network"]);
    expect(noNetwork.tools.map((t) => t.name)).not.toContain("WebFetch");
    expect(noNetwork.tools.map((t) => t.name)).not.toContain("WebSearch");

    const noBash = await select("claude-code", ["bash:no-bash"]);
    expect(noBash.tools.map((t) => t.name)).not.toContain("Bash");

    const cursor = await select("cursor");
    expect(cursor.tools.find((tool) => tool.name === "Grep")?.uncontrolled).toBeTruthy();
    expect(
      resolveNativeTools(
        cursor,
        records.find((record) => record.id === "cursor")!,
        "hosted",
      ).refused,
    ).toEqual({});

    const restricted = await select("cursor", ["no-secrets"]);
    expect(
      resolveNativeTools(
        restricted,
        records.find((record) => record.id === "cursor")!,
        "hosted",
      ).conflicts,
    ).toHaveProperty("Grep");
  });

  describe("identity bag and bound selection", () => {
    const bashBag = {
      name: "bash",
      tools: [{ name: "Bash", namespace: "bash", access: "write" as const }],
    };
    const githubBag = {
      name: "github",
      tools: [
        { name: "list_prs", namespace: "github", access: "read" as const },
        { name: "merge_pr", namespace: "github", access: "write" as const },
      ],
    };

    const base = resolveIdentityConfig({
      id: 1,
      token: "base",
      actor_id: 1,
      name: "barry",
      created_at: "",
      last_used_at: null,
      metadata: {
        bags: ["bash"],
        bounds: [
          {
            readonly: {
              optional: true,
              description: "Read only",
              tools: { deny: ["*:write"] },
            },
          },
        ],
      },
    });

    const row = (metadata: IdentityMetadata): IdentityRecord => ({
      id: 2,
      token: "child",
      actor_id: 1,
      name: "child",
      created_at: "",
      last_used_at: null,
      metadata,
    });

    it("offers local optional bags and bounds without enabling them by default", async () => {
      const identity = row({
        bags: ["bash"],
        bag_configs: { github: { optional: true } },
        bounds: [
          {
            "no-push": {
              optional: true,
              description: "No push",
              bash: { deny: ["git push*"] },
            },
          },
        ],
      });
      identity.metadata.bags = ["bash", "github"];

      const defaultTools = await resolve.tools(identity, {
        bags: [
          { ...bashBag, optional: true },
          { ...githubBag, optional: true },
        ],
        base,
      });
      expect(defaultTools.map((t) => t.namespace)).toEqual(["bash"]);

      const selectedTools = await resolve.tools(identity, {
        bags: [bashBag, githubBag],
        bounds: ["no-push"],
        base,
      });
      expect(selectedTools.map((t) => t.namespace)).toContain("github");

      const selectedBound = await resolve.bound(identity, {
        bounds: ["no-push"],
        base,
      });
      expect(selectedBound.bash?.deny).toEqual(["git push*"]);

      const selectable = await resolve.selectable(identity, { base });
      expect(selectable.bags).toEqual(["bash", "github"]);
      expect(selectable.bounds.map((b) => b.name)).toContain("no-push");
    });

    it("keeps required identity bounds when base defaults are disabled", async () => {
      const identity = row({
        bounds: [
          {
            safe: {
              description: "Safe",
              tools: { deny: ["*:Write"] },
            },
          },
        ],
      });
      const bound = await resolve.bound(identity, { defaults: false, base });
      expect(bound.tools?.deny).toEqual(["*:Write"]);
    });

    it("turns a base default bag off when the identity marks it optional", async () => {
      const identity = row({
        bags: ["bash"],
        bag_configs: { bash: { optional: true } },
      });
      const tools = await resolve.tools(identity, {
        bags: [{ ...bashBag, optional: true }],
        base,
      });
      expect(tools).toEqual([]);

      const readonlyBound = await resolve.bound(undefined, {
        bounds: ["readonly"],
        base,
      });
      expect(readonlyBound.tools?.deny).toEqual(["*:write"]);
    });

    it("uses a pinned Bound directly in resolve.tools without re-reading live identity.bounds", async () => {
      const identity = row({
        bags: ["github"],
        bounds: [],
      });
      const pinnedBound = await resolve.bound(identity, { base });

      identity.metadata.bounds = [
        {
          lockdown: {
            description: "Lockdown",
            tools: { deny: ["*"] },
          },
        },
      ];

      const pinnedTools = await resolve.tools(identity, {
        bags: [githubBag],
        bound: pinnedBound,
        defaults: false,
        base,
      });
      expect(pinnedTools.map((t) => t.name)).toEqual(["list_prs", "merge_pr"]);

      const unpinnedTools = await resolve.tools(identity, {
        bags: [githubBag],
        defaults: false,
        base,
      });
      expect(unpinnedTools).toEqual([]);
    });

    it("refuses unknown bound names (fail-closed) and retired bound_id", async () => {
      await expect(
        resolve.bound(undefined, { bounds: ["typo"], base }),
      ).rejects.toThrow("unknown selected bound typo");
      await expect(
        resolve.bound(row({ bound_id: 7 }), { base }),
      ).rejects.toMatchObject({ reason: "conflict", hint: "barry doctor --fix" });
    });

    it("resolves Barry.bound(null, ...) and Barry.bound(identityId, ...) when Barry.use(identities) is installed", async () => {
      const { installationOwner } = await import("../installation-owner.js");
      const { actorId } = installationOwner().provision({ username: "owner" });
      const created = await Identities.create({
        actor_id: actorId,
        name: "owner-id",
        metadata: {
          bounds: [
            {
              "no-write": {
                description: "No write",
                tools: { deny: ["*:write"] },
              },
            },
          ],
        },
      });
      Barry.use(identities);
      try {
        const nullBound = await Barry.bound(null, ["git:read"]);
        expect(nullBound?.tools?.deny).toEqual(["git:write"]);

        const idBound = await Barry.bound(created.id, ["git:read"]);
        expect(idBound?.tools?.deny).toEqual(["*:write", "git:write"]);
      } finally {
        Barry.reset();
      }
    });
  });
});
