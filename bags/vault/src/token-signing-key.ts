/** Private bootstrap state; replacing this key invalidates issued vault tokens. */
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bagDataDir } from "@barry-rocks/sdk/services";

export function vaultTokenSigningKeyPath(dir = bagDataDir("vault")): string {
  return join(dir, "token-signing-key");
}

function readKey(path: string): string {
  const secret = readFileSync(path, "utf8").trim();
  if (!secret) throw new Error(`${path} is empty. Restore it from a backup: regenerating it invalidates every issued token.`);
  return secret;
}

export function vaultTokenSigningKey(path = vaultTokenSigningKeyPath()): string {
  try {
    return readKey(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(16).toString("hex")}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(descriptor, `${randomBytes(32).toString("hex")}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    // Publish complete bytes without replacing a key another starter owns.
    try {
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const directoryDescriptor = openSync(directory, "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
    return readKey(path);
  } finally {
    unlinkSync(temporary);
  }
}
