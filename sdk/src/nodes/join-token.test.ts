import { expect, it } from "vitest";
import { decodeJoinToken, encodeJoinToken, ownerUrl } from "./join-token.js";
// Frozen master decoder (285639e70aeae81e34cf29786cf6e88c0bd360dc), not this branch's decoder.
import { decodeJoinToken as decodeMasterJoinToken } from "../../../cli/scripts/master-join-token.js";

const token = { v: 1 as const, owner: "owner-1", name: "mac", worker: "worker-1", url: "https://laptop.example:8451/", credential: `barry_wk_${"x".repeat(43)}` };

it("round-trips a join token and normalizes the owner address", () => {
  const text = encodeJoinToken(token);
  expect(text.startsWith("barry_wj1.")).toBe(true);
  expect(decodeJoinToken(`  ${text}\n`)).toEqual({ ...token, url: "https://laptop.example:8451" });
});

it("emits exactly the fields accepted by master's strict version 1 decoder", () => {
  const encoded = encodeJoinToken(token);
  expect(decodeMasterJoinToken(encoded)).toEqual({ ...token, url: "https://laptop.example:8451" });
  expect(Object.keys(JSON.parse(Buffer.from(encoded.slice("barry_wj1.".length), "base64url").toString()))).toEqual(["v", "owner", "name", "worker", "url", "credential"]);
  expect(() => encodeJoinToken({ ...token, jobs: null })).toThrow();
  expect(() => encodeJoinToken({ ...token, expiresAt: 1_800_000_000_000 })).toThrow();
  expect(() => decodeMasterJoinToken(encodeJoinToken({ ...token, v: 2, jobs: ["bag:job@1"] }))).toThrow(/not a join token/);
});

it("refuses damaged tokens, other prefixes, non-worker credentials and unsafe addresses", () => {
  expect(() => decodeJoinToken("barry_wj1.!!!")).toThrow(/damaged/);
  expect(() => decodeJoinToken(encodeJoinToken(token).replace("barry_wj1.", "barry_wj2."))).toThrow(/not a join token|version does not match/);
  expect(() => encodeJoinToken({ ...token, credential: "x".repeat(60) })).toThrow();
  for (const url of ["http://laptop.example", "https://user:pass@laptop.example", "https://laptop.example/?token=1", "not a url"]) {
    expect(() => ownerUrl(url)).toThrow();
  }
});
