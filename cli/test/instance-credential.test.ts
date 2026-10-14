/**
 * Which secret the CLI sends to Barry's own services.
 *
 * Found rehearsing the cutover: a shell that exports the installed instance's
 * BARRY_SECRET, running `BARRY_HOME=<other> barry session list`, sent the
 * installed instance's secret to the other instance, which answered 401 and
 * now held it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setInstanceEnvValue, barryEnvPath, barryConfigDir } from "@barry-rocks/sdk/services";

import { useInstanceSecret } from "../src/config.js";

const saved = { home: process.env.BARRY_HOME, secret: process.env.BARRY_SECRET };

beforeEach(() => {
  process.env.BARRY_HOME = mkdtempSync(join(tmpdir(), "barry-instance-credential-"));
  delete process.env.BARRY_SECRET;
});

afterEach(() => {
  for (const [key, value] of [["BARRY_HOME", saved.home], ["BARRY_SECRET", saved.secret]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("the secret the CLI uses", () => {
  it("is the named instance's own, even when the shell exports another instance's", async () => {
    setInstanceEnvValue("BARRY_SECRET", "this-instance", barryEnvPath());
    process.env.BARRY_SECRET = "the-installed-instance";
    await useInstanceSecret();
    expect(process.env.BARRY_SECRET).toBe("this-instance");
  });

  it("is the instance's when nothing else is set", async () => {
    setInstanceEnvValue("BARRY_SECRET", "this-instance", barryEnvPath());
    await useInstanceSecret();
    expect(process.env.BARRY_SECRET).toBe("this-instance");
  });

  it("does not use an ambient credential when the named instance has none", async () => {
    process.env.BARRY_SECRET = "from-the-caller";
    await useInstanceSecret();
    expect(process.env.BARRY_SECRET).toBeUndefined();
  });
  it("rejects a broken authored reference despite shell and default-file credentials", async () => {
    setInstanceEnvValue("BARRY_SECRET", "default-file-secret", barryEnvPath());
    process.env.BARRY_SECRET = "ambient-secret";
    mkdirSync(barryConfigDir(), { recursive: true });
    writeFileSync(join(barryConfigDir(), "barry.yaml"), "secrets:\n  BARRY_SECRET:\n    in: vault\n    item: missing-instance\n    field: password\n");
    await expect(useInstanceSecret()).rejects.toThrow("BARRY_SECRET");
    expect(process.env.BARRY_SECRET).toBeUndefined();
  });

});
