import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { z } from "zod";
import { ArtifactError, IdentityIdSchema } from "../types.js";

export const ActivationJournalSchema = z.strictObject({
  format: z.literal(1), id: z.string().uuid(),
  state: z.enum(["prepared", "sealed", "preserved", "installed", "active"]),
  filepath: z.string(), identity: IdentityIdSchema, candidate: z.string(), previous: z.string(),
  generation: z.string().regex(/^[a-f0-9]{32}$/),
  previousGeneration: z.string().regex(/^[a-f0-9]{32}$/),
});
export type ArtifactActivationJournal = z.infer<typeof ActivationJournalSchema>;

export function readArtifactActivation(filepath: string): ArtifactActivationJournal | undefined {
  let handle: number;
  try { handle = openSync(`${filepath}.activation.json`, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  try {
    const file = fstatSync(handle);
    if (!file.isFile() || file.size > 16_384) throw new ArtifactError("unavailable");
    const journal = ActivationJournalSchema.parse(JSON.parse(readFileSync(handle, "utf8")));
    if (journal.filepath !== filepath) throw new ArtifactError("unavailable");
    return journal;
  } finally { closeSync(handle); }
}

export function requireArtifactActivationComplete(filepath: string): void {
  const journal = readArtifactActivation(filepath);
  if (journal && journal.state !== "active") throw new ArtifactError("unavailable");
}
