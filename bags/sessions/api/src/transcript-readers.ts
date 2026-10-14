import type { Adapters } from "@barry-rocks/sdk/adapters/harnesses";
import type { TranscriptSource, TranscriptSession } from "@barry-rocks/sdk/transcripts";

let installedReaders: (() => Promise<Record<string, TranscriptSource>>) | undefined;

export function setInstalledTranscriptReaders(readers: () => Promise<Record<string, TranscriptSource>>): void {
  installedReaders = readers;
}

export async function transcriptRootsFor(provider: string, session: TranscriptSession): Promise<readonly string[]> {
  const reader = installedReaders ? (await installedReaders())[provider] : undefined;
  return reader?.roots ? reader.roots(session) : [];
}

/**
 * Each installed adapter's transcript reader, under every name a session row
 * may carry for it — its id, and the former ids rows written before a rename
 * still hold. A reader missing under a row's name is a session whose
 * transcript is never captured, with nothing failing to say so.
 */
export async function transcriptReadersOf(
  adapters: Pick<Adapters, "installed" | "load">,
  unavailable: (adapter: string, error: unknown) => void,
): Promise<Record<string, TranscriptSource>> {
  const readers: Record<string, TranscriptSource> = {};
  for (const record of adapters.installed()) {
    try {
      const transcript = (await adapters.load(record.id)).transcript;
      if (transcript) for (const name of [record.id, ...(record.aliases ?? [])]) readers[name] = transcript;
    } catch (err) {
      unavailable(record.id, err);
    }
  }
  return readers;
}
