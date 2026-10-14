/**
 * `<identity> identity show` on a file-backed identity prints the dates of its
 * row, not the moment the file was read.
 *
 * Pins BARRY_HOME and BARRY_IDENTITIES_DB itself, before anything imports them,
 * like pack-identity-file.test.ts.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const scratch = vi.hoisted(() => {
  const root = `${process.env.TMPDIR ?? "/tmp"}/show-identity-file-${process.pid}-${Date.now()}`;
  process.env.BARRY_HOME = `${root}/home`;
  process.env.BARRY_IDENTITIES_DB = `${root}/identities.db`;
  return { root };
});

import { showIdentityCommand } from "../src/commands/identity.js";
import { identityRecords } from "@barry-rocks/identities-bag";
import { provisionOwner } from "./helpers/identities.js";

let printed: string[] = [];
let actorId: number;
let dir: string;

async function show(): Promise<string[]> {
  printed = [];
  await showIdentityCommand("showtester");
  return printed.filter((line) => /^\s+(Created|Last used):/.test(line));
}

beforeAll(async () => {
  mkdirSync(scratch.root, { recursive: true });
  actorId = provisionOwner("Show Tester");
  // Written by hand rather than created, so there is no row until a test makes one.
  dir = join(process.env.BARRY_HOME!, "app-support", "identities", "showtester");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "identity.yaml"), "name: showtester\n");
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    printed.push(String(line));
  });
});
afterAll(() => {
  vi.useRealTimers();
  rmSync(scratch.root, { recursive: true, force: true });
});

describe("identity show on a file-backed identity", () => {
  it("prints no creation date when no row records one", async () => {
    expect(await show()).toEqual([]);
  });

  it("prints the row's creation date, not the time the file was loaded", async () => {
    const { identityId } = await identityRecords.sync(dir, { actorId });
    const row = (await identityRecords.row(identityId))!;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2031-01-01T00:00:00.000Z"));

    expect(await show()).toEqual([`  Created: ${row.created_at}`]);
  });
});
