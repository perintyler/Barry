import crypto from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";
import {
  deriveKeys,
  generateKdfSalt,
  encrypt,
  decrypt,
  generateSymmetricKey,
  encryptSymmetricKey,
  decryptSymmetricKey,
} from "./crypto.js";

describe("vault crypto", () => {
  describe("deriveKeys", () => {
    it("is deterministic for the same password + email + salt", async () => {
      const salt = generateKdfSalt();
      const a = await deriveKeys("hunter2", "user@example.com", salt);
      const b = await deriveKeys("hunter2", "user@example.com", salt);
      expect(a.encKey.equals(b.encKey)).toBe(true);
      expect(a.macKey.equals(b.macKey)).toBe(true);
    });

    it("differs for a different password", async () => {
      const salt = generateKdfSalt();
      const a = await deriveKeys("hunter2", "user@example.com", salt);
      const b = await deriveKeys("different", "user@example.com", salt);
      expect(a.encKey.equals(b.encKey)).toBe(false);
    });

    it("differs for a different email (email is part of the KDF input)", async () => {
      const salt = generateKdfSalt();
      const a = await deriveKeys("hunter2", "a@example.com", salt);
      const b = await deriveKeys("hunter2", "b@example.com", salt);
      expect(a.encKey.equals(b.encKey)).toBe(false);
    });
  });

  describe("encrypt / decrypt round-trip", () => {
    let encKey: Buffer, macKey: Buffer;
    beforeAll(async () => { ({ encKey, macKey } = await deriveKeys("pw", "user@example.com", generateKdfSalt())); });

    it("round-trips arbitrary plaintext", async () => {
      for (const plaintext of ["", "hello", "a".repeat(1000), "🔐 unicode ✓", JSON.stringify({ a: 1 })]) {
        expect(decrypt(encrypt(plaintext, encKey, macKey), encKey, macKey)).toBe(plaintext);
      }
    });

    it("produces a different ciphertext each time (random IV)", async () => {
      expect(encrypt("same", encKey, macKey)).not.toBe(encrypt("same", encKey, macKey));
    });

    it("rejects a tampered ciphertext (HMAC check)", async () => {
      const ct = encrypt("secret", encKey, macKey);
      const [version, payload] = ct.split(".");
      const [iv, ciphertext, mac] = payload.split("|");
      const bytes = Buffer.from(ciphertext, "base64");
      bytes[0] ^= 1;
      const tampered = `${version}.${iv}|${bytes.toString("base64")}|${mac}`;
      expect(() => decrypt(tampered, encKey, macKey)).toThrow();
    });

    // Flipping a ciphertext byte corrupts plaintext block 0, but CBC padding lives
    // in the LAST block and still validates -- so `decrypt` throws either way and a
    // bare toThrow() cannot tell "the MAC rejected it" from "padding happened to
    // fail". Flipping the IV instead alters ONLY block 0 and leaves padding intact,
    // so decryption would SUCCEED and return attacker-influenced plaintext if the
    // HMAC check were removed. This is the test that reddens when it is.
    it("rejects an IV-flipped ciphertext that would otherwise decrypt cleanly (MAC is the only defence)", async () => {
      const ct = encrypt("attack-at-dawn-0123456789abcdef", encKey, macKey);
      const [version, payload] = ct.split(".");
      const [ivB64, ctB64, macB64] = payload.split("|");
      const iv = Buffer.from(ivB64, "base64");
      iv[0] ^= 0xff;
      const forged = `${version}.${iv.toString("base64")}|${ctB64}|${macB64}`;
      expect(() => decrypt(forged, encKey, macKey)).toThrow(/MAC verification failed/);
    });

    it("rejects decryption with the wrong key", async () => {
      const other = await deriveKeys("other", "user@example.com", generateKdfSalt());
      const ct = encrypt("secret", encKey, macKey);
      expect(() => decrypt(ct, other.encKey, other.macKey)).toThrow();
    });
  });

  describe("symmetric key wrapping", () => {
    it("round-trips a wrapped symmetric key", async () => {
      const master = await deriveKeys("pw", "user@example.com", generateKdfSalt());
      const symKey = generateSymmetricKey();
      const wrapped = encryptSymmetricKey(symKey, master.encKey, master.macKey);
      const unwrapped = decryptSymmetricKey(wrapped, master.encKey, master.macKey);
      // The unwrapped keys should decrypt what the original symmetric key encrypted.
      const item = encrypt("item-secret", unwrapped.encKey, unwrapped.macKey);
      expect(decrypt(item, unwrapped.encKey, unwrapped.macKey)).toBe("item-secret");
    });
    it("preserves all 256 byte values through the latin1 round-trip", async () => {
      // encryptSymmetricKey stuffs raw key bytes through a JS string as
      // "binary"/latin1. It is lossless, but only for latin1 — the same code
      // written with an implicit utf8 default mangles every byte above 0x7f
      // while still producing a valid MAC, so the failure surfaces as garbage
      // plaintext rather than as an error. Any new wrapping code must use the
      // same encoding; this pins it.
      const master = await deriveKeys("pw", "user@example.com", generateKdfSalt());
      // Exercise encryptSymmetricKey/decryptSymmetricKey THEMSELVES rather than
      // encrypt/decrypt with a hand-rolled latin1 string: a test that rolls its
      // own encoding passes happily while the real wrapper uses the wrong one.
      const symKey = generateSymmetricKey();
      const wrapped = encryptSymmetricKey(symKey, master.encKey, master.macKey);
      const back = decryptSymmetricKey(wrapped, master.encKey, master.macKey);
      expect(back.encKey.equals(symKey.subarray(0, 32))).toBe(true);
      expect(back.macKey.equals(symKey.subarray(32, 64))).toBe(true);
    });

    it("rejects a ciphertext whose version tag it does not know", async () => {
      // decrypt() is the single gate every decrypt path funnels through, and a
      // new key format would arrive here as a new tag. It must THROW, not
      // return something — an unknown format that decodes to garbage is worse
      // than one that refuses.
      const master = await deriveKeys("pw", "user@example.com", generateKdfSalt());
      const valid = encrypt("secret", master.encKey, master.macKey);
      const retagged = `9.${valid.slice(2)}`;
      expect(() => decrypt(retagged, master.encKey, master.macKey)).toThrow(/Unsupported encryption type/);
    });
  });
});

it.each([null, "fixed-kdf-salt"])("keeps async KDF bytes compatible with the existing format (%s)", async salt => {
  const password = "fixed-password", email = "USER@example.com";
  const master = crypto.pbkdf2Sync(password, salt ? `${email.toLowerCase()}:${salt}` : email.toLowerCase(), 600_000, 32, "sha256");
  const actual = await deriveKeys(password, email, salt);
  expect(actual.masterKey).toEqual(master);
  expect(actual.encKey).toEqual(Buffer.from(crypto.hkdfSync("sha256", master, "", Buffer.from("enc"), 32)));
  expect(actual.macKey).toEqual(Buffer.from(crypto.hkdfSync("sha256", master, "", Buffer.from("mac"), 32)));
  expect(actual.masterPasswordHash).toBe(crypto.pbkdf2Sync(master, password, 1, 32, "sha256").toString("base64"));
});

it("lets a picker repaint while key derivation is in progress", async () => {
  let ready = false;
  const keys = deriveKeys("fixed-password", "user@example.com", "fixed-kdf-salt").then(value => { ready = true; return value; });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(ready).toBe(false);
  await keys;
});
