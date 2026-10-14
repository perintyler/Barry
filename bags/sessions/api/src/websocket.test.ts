import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { isLoopbackAddress, getClientIp } from "./websocket.js";
import type { IncomingMessage } from "http";
import type { Socket } from "net";

function mockRequest(overrides: {
  remoteAddress?: string;
  headers?: Record<string, string | string[] | undefined>;
} = {}): IncomingMessage {
  return {
    socket: { remoteAddress: overrides.remoteAddress || "127.0.0.1" } as Socket,
    headers: overrides.headers || {},
  } as IncomingMessage;
}

describe("isLoopbackAddress", () => {
  it("recognizes IPv6 loopback", () => {
    expect(isLoopbackAddress("::1")).toBe(true);
  });

  it("recognizes IPv4 loopback", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
  });

  it("recognizes IPv4-mapped IPv6 loopback", () => {
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("rejects a non-loopback address", () => {
    expect(isLoopbackAddress("192.168.1.1")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isLoopbackAddress("")).toBe(false);
  });
});

describe("getClientIp", () => {
  it("returns remoteAddress by default", () => {
    const req = mockRequest({ remoteAddress: "192.168.1.50" });
    expect(getClientIp(req)).toBe("192.168.1.50");
  });

  it("ignores X-Forwarded-For when BARRY_TRUST_PROXY is not set", () => {
    const saved = process.env.BARRY_TRUST_PROXY;
    delete process.env.BARRY_TRUST_PROXY;
    try {
      const req = mockRequest({
        remoteAddress: "127.0.0.1",
        headers: { "x-forwarded-for": "10.0.0.1" },
      });
      expect(getClientIp(req)).toBe("127.0.0.1");
    } finally {
      if (saved !== undefined) process.env.BARRY_TRUST_PROXY = saved;
    }
  });

  describe("with BARRY_TRUST_PROXY=true", () => {
    let saved: string | undefined;
    beforeEach(() => { saved = process.env.BARRY_TRUST_PROXY; process.env.BARRY_TRUST_PROXY = "true"; });
    afterEach(() => { if (saved !== undefined) process.env.BARRY_TRUST_PROXY = saved; else delete process.env.BARRY_TRUST_PROXY; });

    it("uses X-Forwarded-For when peer is loopback", () => {
      const req = mockRequest({
        remoteAddress: "127.0.0.1",
        headers: { "x-forwarded-for": "203.0.113.50" },
      });
      expect(getClientIp(req)).toBe("203.0.113.50");
    });

    it("uses first IP from comma-separated X-Forwarded-For", () => {
      const req = mockRequest({
        remoteAddress: "::1",
        headers: { "x-forwarded-for": "203.0.113.50, 10.0.0.1" },
      });
      expect(getClientIp(req)).toBe("203.0.113.50");
    });

    it("ignores X-Forwarded-For when peer is not loopback", () => {
      const req = mockRequest({
        remoteAddress: "192.168.1.50",
        headers: { "x-forwarded-for": "10.0.0.1" },
      });
      expect(getClientIp(req)).toBe("192.168.1.50");
    });

    it("falls back to remoteAddress when X-Forwarded-For is empty", () => {
      const req = mockRequest({
        remoteAddress: "127.0.0.1",
        headers: { "x-forwarded-for": "" },
      });
      expect(getClientIp(req)).toBe("127.0.0.1");
    });
  });
});
