import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { barryReleasesDir } from "@barry-rocks/sdk/services";

const identifier = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i).refine(value => !value.includes(".."));
const installationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("release"), version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/), commit: z.string().regex(/^[a-f0-9]{40}$/) }),
  z.strictObject({ kind: z.literal("link"), target: z.string().startsWith("/"), commit: z.string().nullable(), node: z.string().startsWith("/") }),
]);
export const receiptSchema = z.strictObject({
  format: z.literal(1), id: z.string().regex(/^\d{8}T\d{9}Z-[a-f0-9]{8}$/),
  kind: z.enum(["upgrade", "rollback"]), state: z.enum(["started", "switched", "complete", "reverted"]),
  from: installationSchema, to: installationSchema,
  generations: z.strictObject({ before: identifier.nullable(), after: identifier.nullable() }),
  snapshot: z.string().nullable(), services: z.array(z.string()), started: z.iso.datetime(),
  finished: z.iso.datetime().optional(), problem: z.string().optional(),
});
export type Installation = z.infer<typeof installationSchema>;
export type Receipt = z.infer<typeof receiptSchema>;
export function receiptId(): string {
  return `${new Date().toISOString().replace(/[-:.]/g, "")}-${randomBytes(4).toString("hex")}`;
}
export function writeReceipt(receipt: Receipt): void {
  const parsed = receiptSchema.parse(receipt), directory = join(barryReleasesDir(), "upgrades");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(parsed), { mode: 0o600, flag: "wx" });
    renameSync(temporary, join(directory, `${parsed.id}.json`));
  } finally { rmSync(temporary, { force: true }); }
}
export function readReceipts(): Receipt[] {
  const directory = join(barryReleasesDir(), "upgrades");
  let names: string[];
  try { names = readdirSync(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return []; }
  return names.filter(name => name.endsWith(".json")).sort().reverse().map(name => {
    const receipt = receiptSchema.parse(JSON.parse(readFileSync(join(directory, name), "utf8")));
    if (name !== `${receipt.id}.json`) throw new Error(`receipt id differs from ${name}`);
    return receipt;
  });
}
export function installationLabel(installation: Installation): string {
  return installation.kind === "release" ? `release ${installation.version}` : `linked checkout at ${installation.target}`;
}
