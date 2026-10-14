import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveAttachment,
  getAttachment,
  getAttachmentMetadata,
  listAttachments,
  validateAttachment,
  MAX_ATTACHMENT_SIZE_BYTES,
} from "./attachments-store.js";

describe("attachments-store", () => {
  let tempHome: string;
  const originalHome = process.env.BARRY_HOME;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "barry-test-attachments-"));
    process.env.BARRY_HOME = tempHome;
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.BARRY_HOME = originalHome;
    else delete process.env.BARRY_HOME;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("rejects crafted session directories before writing outside the attachments root", async () => {
    for (const sessionId of ["../escape", "../../escape", ".", "a/../../escape"]) {
      await expect(saveAttachment(sessionId, { name: "x.txt", mimeType: "text/plain", data: Buffer.from("x") })).rejects.toThrow(/session|root|path/i);
      await expect(listAttachments(sessionId)).rejects.toThrow(/session|root|path/i);
    }
  });

  it("rejects a session directory symlink that escapes the attachments root", async () => {
    const root = join(tempHome, "app-support", "attachments");
    const outside = join(tempHome, "outside");
    mkdirSync(root, { recursive: true }); mkdirSync(outside);
    symlinkSync(outside, join(root, "linked"));
    await expect(saveAttachment("linked", { name: "x.txt", mimeType: "text/plain", data: Buffer.from("x") })).rejects.toThrow(/escapes/);
    await expect(listAttachments("linked")).rejects.toThrow(/escapes/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("saves, lists, and reads back an attachment blob", async () => {
    const data = Buffer.from("console.log('hello world');", "utf8");
    const record = await saveAttachment("sess-1", {
      name: "hello.ts",
      mimeType: "application/typescript",
      data,
    });

    expect(record.id).toMatch(/^att_[a-f0-9]+$/);
    expect(record.name).toBe("hello.ts");
    expect(record.size).toBe(data.length);
    expect(record.mimeType).toBe("application/typescript");

    const meta = await getAttachmentMetadata("sess-1", record.id);
    expect(meta).toEqual(record);

    const full = await getAttachment("sess-1", record.id);
    expect(full?.meta).toEqual(record);
    expect(full?.data.toString("utf8")).toBe("console.log('hello world');");

    const list = await listAttachments("sess-1");
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(record.id);
  });

  it("refuses attachments exceeding the 25MB ceiling", async () => {
    const oversized = Buffer.alloc(MAX_ATTACHMENT_SIZE_BYTES + 1024);
    await expect(
      saveAttachment("sess-1", {
        name: "huge.bin",
        mimeType: "application/json",
        data: oversized,
      }),
    ).rejects.toThrow(/exceeds 25MB ceiling/);
  });

  it("refuses disallowed MIME types", async () => {
    const file = {
      name: "malware.exe",
      mimeType: "application/x-dosexec",
      size: 512,
    };
    const check = validateAttachment(file);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.status).toBe(415);
      expect(check.error).toContain("Unsupported media type");
    }
  });

  it("allows standard source code, image, and document types", () => {
    const valid = [
      "text/plain",
      "text/markdown",
      "application/json",
      "application/pdf",
      "image/png",
      "image/jpeg",
      "application/typescript",
    ];
    for (const mime of valid) {
      expect(validateAttachment({ name: "file.ext", mimeType: mime, size: 100 })).toEqual({ ok: true });
    }
  });
});
