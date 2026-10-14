import { describe, expect, it } from "vitest";
import { checkAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import { parseManifest } from "@barry-rocks/sdk/bags";
import adapter from "./adapter.js";
import { VERIFIED_ON } from "./modes.js";

const bagManifest = parseManifest(new URL("..", import.meta.url).pathname)!;

describe("Pi Adapter", () => {
  it("passes checkAdapter with 0 problems", () => {
    const { problems, checked } = checkAdapter(adapter, { bagManifest });
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(15);
  });

  it("declares identity, defaultMode, and requirements matching pinned build", () => {
    expect(adapter.id).toBe("pi");
    expect(adapter.label).toBe("Pi");
    expect(adapter.defaultMode).toBe("hosted");

    const req = adapter.requirements?.binary;
    expect(req).toBeDefined();
    expect(req?.pin?.version).toBe(VERIFIED_ON);
    expect(new RegExp(req.versionPattern).test(VERIFIED_ON)).toBe(true);
  });

  it("configures hosted mode and refuses guest and instrumented vendor-login modes", () => {
    expect(adapter.modes.hosted).not.toBeNull();
    expect(adapter.modes.hosted?.start).toBeTypeOf("function");
    expect(adapter.modes.hosted?.adopt).toBeTypeOf("function");
    expect(adapter.modes.hosted?.guarantees).toMatchObject({
      capture: "total",
      delivery: "wake",
      steer: true,
      interrupt: true,
      gating: "per-call",
      keepsVendorUi: false,
      identity: "inherent",
    });

    expect(adapter.modes.instrumented).toBeNull();
    expect(adapter.modes.guest).toBeNull();
  });

  it("declares native tools, offered models, and transcript support", () => {
    expect(adapter.nativeTools.length).toBe(13);
    expect(adapter.offeredModels?.length).toBeGreaterThan(0);
    expect(adapter.listModels).toBeTypeOf("function");
    expect(adapter.transcript).toBeDefined();
    expect(adapter.transcript?.locate).toBeTypeOf("function");
    expect(adapter.transcript?.read).toBeTypeOf("function");
  });
});
