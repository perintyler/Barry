/**
 * Harness IDs name agent loops and vendor IDs name model providers; both remain open strings for installed integrations and data catalogs.
 * See docs/decisions/0011-sdk-runtime-invariants.md for the retained rationale.
 */

import { z } from "zod";

export type VendorId = string;
export type HarnessId = string;

/**
 * What a harness id may look like — shape, not membership. Ids reach
 * directory names and CLI flags, so one that could not be either is wrong
 * before anyone asks whether that harness is installed; whether it IS is the
 * installed-adapters record's answer.
 *
 * A RegExp rather than a zod schema because the workspace is split across
 * zod 3 and zod 4, and both need it.
 */
export const HARNESS_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
export const HARNESS_ID_MAX_LENGTH = 64;

/**
 * A validated harness id — SHAPE, not membership.
 *
 * Was a closed enum of the four Barry ships, which made a third-party adapter
 * impossible to record. Whether a harness is installed is answered where
 * installation is recorded (`~/.barry/adapters.json`, and the
 * `agent_adapters` foreign key beneath session rows); this answers whether an
 * id could be one at all.
 */
export const HarnessIdSchema = z
  .string()
  .min(1)
  .max(HARNESS_ID_MAX_LENGTH)
  .regex(HARNESS_ID_PATTERN, "an adapter id is lowercase letters, digits and dashes");

export function isHarnessId(id: string): boolean {
  return id.length <= HARNESS_ID_MAX_LENGTH && HARNESS_ID_PATTERN.test(id);
}

/** A model as its vendor names it: `ollama/qwen3:4b`, `anthropic/claude-opus-5`. */
export type ModelRef = `${VendorId}/${string}`;

export type ModelKind = "completion" | "embedding" | "decision";

/** Who is at the controls of a session, and so what Barry holds. */
export type ModeId = "hosted" | "instrumented" | "guest";

export const MODE_IDS: readonly ModeId[] = ["hosted", "instrumented", "guest"];

/**
 * Plain JSON Schema rather than a zod type: the workspace is split across zod 3
 * and zod 4, and accepting either would force every contract to pick a side.
 */
export type JsonSchema = Record<string, unknown>;

export function modelRef(vendor: VendorId, model: string): ModelRef {
  return `${vendor}/${model}`;
}

/**
 * Split a ref at its FIRST slash. Model ids may contain slashes themselves —
 * an Ollama model pulled from Hugging Face is `hf.co/org/name` — so the vendor
 * is everything before the first one and the model is everything after.
 */
export function parseModelRef(ref: string): { vendor: VendorId; model: string } | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  return { vendor: ref.slice(0, slash), model: ref.slice(slash + 1) };
}


/** nanoid's alphabet: 64 URL-safe characters, so one random byte's low six bits pick one. */
const ID_ALPHABET = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

/** What an id may start with: anything but a dash, so an id given on a command line is never read as an option. */
const ID_LEADING = ID_ALPHABET.replace("-", "");

/** A new opaque id: 21 URL-safe characters, as nanoid makes them, from Web Crypto so it runs anywhere. */
export function generateId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(21));
  let id = ID_LEADING[bytes[0] % ID_LEADING.length];
  for (const byte of bytes.subarray(1)) id += ID_ALPHABET[byte & 63];
  return id;
}
