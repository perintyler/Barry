import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { barryConfigDir } from "@barry-rocks/sdk/services";
import { acquireLock } from "@barry-rocks/sdk/internal/services";

interface StoredSelection {
  bags: string[];
  bounds?: string[];
  updatedAt: string;
}

interface SelectionMemory {
  version: 2;
  selections: Record<string, StoredSelection>;
}

export interface SessionSelectionKey {
  identityId: number;
  harness: string;
}

export interface RecalledSelection {
  bags: string[];
  bounds: string[];
}

const keyOf = ({ identityId, harness }: SessionSelectionKey) => JSON.stringify([identityId, harness]);

function sanitizeList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  if (!raw.every((name) => typeof name === "string" && name.trim())) return null;
  return [...new Set(raw.map((name) => name.trim()))];
}

function read(directory: string): SelectionMemory {
  try {
    const value = JSON.parse(readFileSync(join(directory, "session-selections.json"), "utf8")) as SelectionMemory;
    if (
      value.version === 2 &&
      value.selections &&
      typeof value.selections === "object" &&
      !Array.isArray(value.selections)
    ) {
      return value;
    }
  } catch {
    /* Missing or corrupt preferences start with no selection. */
  }
  return { version: 2, selections: {} };
}

export function recallSelection(
  key: SessionSelectionKey,
  directory = barryConfigDir(),
): RecalledSelection {
  const entry = read(directory).selections[keyOf(key)];
  if (!entry) return { bags: [], bounds: [] };
  const bags = sanitizeList(entry.bags);
  if (bags === null) return { bags: [], bounds: [] };
  const bounds = entry.bounds === undefined ? [] : sanitizeList(entry.bounds);
  if (bounds === null) return { bags: [], bounds: [] };
  return { bags, bounds };
}

/** Preferences cannot prevent a launch; return false if this instance cannot save them. */
export function rememberSelection(
  input: SessionSelectionKey & { bags: string[]; bounds?: string[] },
  directory = barryConfigDir(),
): boolean {
  const bags = [...new Set(input.bags.map((name) => name.trim()).filter(Boolean))];
  const bounds = [...new Set((input.bounds ?? []).map((name) => name.trim()).filter(Boolean))];
  if (!bags.length && !bounds.length) return true;
  let release: (() => void) | undefined;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    release = acquireLock(directory, "session-selections");
    const memory = read(directory);
    memory.selections[keyOf(input)] = {
      bags,
      bounds,
      updatedAt: new Date().toISOString(),
    };
    const temporary = join(directory, `session-selections.${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(memory, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, join(directory, "session-selections.json"));
    return true;
  } catch {
    return false;
  } finally {
    try {
      release?.();
    } catch {
      /* A preference lock cannot break a launch. */
    }
  }
}
