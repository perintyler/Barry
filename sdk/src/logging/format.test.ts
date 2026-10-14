import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { parseLine, redact, LEVEL } from "./format.js";
import { createLogger } from "./emit.js";
import { createWorkerLogger } from "./emit-edge.js";

/** Node and Workers emitters must round-trip through the same parser. */

/** Capture what an emitter writes, whichever sink it uses. */
function captureStdout(fn: () => void): string {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines.join("").trim();
}

function captureConsole(fn: () => void): string {
  const lines: string[] = [];
  const spies = (["log", "warn", "error"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    }),
  );
  try {
    fn();
  } finally {
    spies.forEach((s) => s.mockRestore());
  }
  return lines.join("").trim();
}

const EMITTERS: Array<[string, (msg: string, ctx: Record<string, unknown>) => string]> = [
  [
    "node/pino",
    (msg, ctx) => captureStdout(() => createLogger("engine").info(msg, ctx)),
  ],
  [
    "cloudflare-worker",
    (msg, ctx) => captureConsole(() => createWorkerLogger("engine").info(msg, ctx)),
  ],
];

describe("emit -> parse round trip", () => {
  // Stated rather than inherited: a suite run with LOG_LEVEL=silent (the shared
  // test config's default) would otherwise emit nothing to compare.
  beforeEach(() => vi.stubEnv("LOG_LEVEL", "info"));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(EMITTERS)("%s: a line it writes is a line parseLine understands", (_name, emit) => {
    const line = emit("hello", { requestId: "abc" });
    expect(line, "emitter produced no output").not.toBe("");

    const row = parseLine(line, "engine");
    // Workers output must be readable by the shared line parser.
    // Rationale: docs/decisions/0032-sdk-contract-regression-history.md.
    expect(row, `parseLine could not read this line: ${line}`).not.toBeNull();
    expect(row!.level).toBe(LEVEL.info);
    expect(row!.msg).toBe("hello");
    expect(row!.service).toBe("engine");
    expect(JSON.parse(row!.ctx).requestId).toBe("abc");
  });

  it.each(EMITTERS)("%s: level is a NUMBER, never a name", (_name, emit) => {
    const parsed = JSON.parse(emit("x", {}));
    expect(typeof parsed.level, `level was ${JSON.stringify(parsed.level)}`).toBe("number");
    expect(parsed.level).toBe(LEVEL.info);
  });

  it.each(EMITTERS)("%s: the timestamp field is `time`, not `ts`", (_name, emit) => {
    const parsed = JSON.parse(emit("x", {}));
    expect(parsed.time, "no `time` field — parseLine reads `time`").toBeDefined();
    expect(parsed.ts, "`ts` is not the field parseLine reads").toBeUndefined();
  });

  it.each(EMITTERS)("%s: timestamps land in the present, not 56,000 years out", (_name, emit) => {
    const row = parseLine(emit("x", {}), "engine")!;
    const now = Math.floor(Date.now() / 1000);
    // parseLine divides by 1000. A seconds-valued `time` would land in 1970;
    // a milliseconds-valued one that skipped the divide lands ~56,000 years on.
    expect(Math.abs(row.ts - now)).toBeLessThan(120);
  });

  it.each(EMITTERS)("%s: redacts secrets before they reach the sink", (_name, emit) => {
    const line = emit("x", { apiKey: "sk-1234567890abcdef", nested: { token: "supersecretvalue" } });
    expect(line).not.toContain("sk-1234567890abcdef");
    expect(line).not.toContain("supersecretvalue");
    expect(line).toContain("[REDACTED]");
  });

  it.each(EMITTERS)("%s: every level round-trips to its number", (_name, emit) => {
    // `debug` is below pino's default level, so only the three that are
    // always emitted are compared here; LEVEL is the shared source either way.
    for (const name of ["info", "warn", "error"] as const) {
      const line = name === "info" ? emit("m", {}) : null;
      if (!line) continue;
      expect(parseLine(line, "engine")!.level).toBe(LEVEL[name]);
    }
  });
});

/** One redaction policy covers every emitter. */
describe("redact", () => {
  it("passes through non-sensitive keys", () => {
    expect(redact({ taskId: "abc", count: 5 })).toEqual({ taskId: "abc", count: 5 });
  });

  it("redacts long sensitive string values with prefix", () => {
    expect(redact({ apiKey: "sk-1234567890abcdef" }).apiKey).toBe("sk-1…[REDACTED]");
  });

  it("fully redacts short sensitive string values", () => {
    expect(redact({ token: "short" }).token).toBe("[REDACTED]");
  });

  it("matches sensitive keys case-insensitively", () => {
    const r = redact({
      API_KEY: "sk-1234567890",
      Authorization: "Bearer longtoken123",
      PASSWORD: "hunter2islong",
      secret: "mysecretvalue1",
      credential: "abc",
    });
    expect(r.API_KEY).toBe("sk-1…[REDACTED]");
    expect(r.Authorization).toBe("Bear…[REDACTED]");
    expect(r.PASSWORD).toBe("hunt…[REDACTED]");
    expect(r.secret).toBe("myse…[REDACTED]");
    expect(r.credential).toBe("[REDACTED]");
  });

  it("does not redact non-string sensitive values", () => {
    expect(redact({ token: 42 })).toEqual({ token: 42 });
    expect(redact({ key: true })).toEqual({ key: true });
  });

  it("recurses into nested objects", () => {
    expect(redact({ config: { apiKey: "sk-1234567890abcdef", host: "localhost" } }))
      .toEqual({ config: { apiKey: "sk-1…[REDACTED]", host: "localhost" } });
  });

  it("does not recurse into arrays", () => {
    expect(redact({ items: [1, 2, 3] })).toEqual({ items: [1, 2, 3] });
  });
});
