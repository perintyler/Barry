import { createHash, pbkdf2Sync, timingSafeEqual } from "node:crypto";

export async function hashShareToken(token: string): Promise<string> {
  return createHash("sha256").update(token).digest("hex");
}

export async function hashSharePassword(password: string, salt: string): Promise<string> {
  return pbkdf2Sync(password, salt, 100_000, 32, "sha256").toString("hex");
}

export async function verifySharePassword(password: string, salt: string, expectedHash: string): Promise<boolean> {
  const actual = Buffer.from(await hashSharePassword(password, salt), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
