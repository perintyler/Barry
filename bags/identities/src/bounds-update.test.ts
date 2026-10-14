import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import type { Server } from "http";

vi.mock("./config/bounds.js", async importOriginal => ({
  ...await importOriginal<typeof import("./config/bounds.js")>(),
  Bounds: {
    list: vi.fn(),
    getById: vi.fn(),
    getByName: vi.fn(),
    create: vi.fn(),
    upsertBound: vi.fn(),
  },
}));

vi.mock("@barry-rocks/sdk/logging", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/logging")>(),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { boundsRouter } from "./bounds.js";
import { Bounds } from "./config/bounds.js";

const existing = {
  id: 19,
  name: "user-no-network",
  description: "All outbound network access denied",
  bound: { network: { actions: ["all"] } },
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/bounds", boundsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => server?.close());

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(Bounds.list).mockResolvedValue([existing] as never);
  vi.mocked(Bounds.getByName).mockResolvedValue(existing as never);
});

describe("PATCH /bounds/:name", () => {
  it("refuses a rename", async () => {
    // Traits reference bounds by name, and file-based identities copy the rules
    // inline — a rename detaches both with nothing pointing at the break.
    const res = await fetch(`${baseUrl}/bounds/user-no-network`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "renamed" }),
    });
    expect(res.status).toBe(400);
    expect(vi.mocked(Bounds.upsertBound)).not.toHaveBeenCalled();
  });

  it("carries the existing rules through a description-only edit", async () => {
    // upsertBound overwrites every column, so an omitted `scope` is an erase,
    // not a no-op. no-network consists of nothing but its network rule.
    const res = await fetch(`${baseUrl}/bounds/user-no-network`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "Still denied" }),
    });
    expect(res.status).toBe(200);
    expect(vi.mocked(Bounds.upsertBound)).toHaveBeenCalledWith(
      expect.objectContaining({ name: "user-no-network", bound: { network: { actions: ["all"] } } }),
    );
  });

  it("rejects a non-object bound rather than storing it", async () => {
    const res = await fetch(`${baseUrl}/bounds/user-no-network`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bound: "everything" }),
    });
    expect(res.status).toBe(400);
    expect(vi.mocked(Bounds.upsertBound)).not.toHaveBeenCalled();
  });

  it("404s an unknown scope", async () => {
    vi.mocked(Bounds.list).mockResolvedValue([]);
    const res = await fetch(`${baseUrl}/bounds/missing`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "x" }),
    });
    expect(res.status).toBe(404);
  });
});
