import { describe, expect, it } from "vitest";
import { checkAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import { parseManifest } from "@barry-rocks/sdk/bags";
import adapter from "./adapter.js";
import { VERIFIED_ON } from "./modes.js";

const bagManifest = parseManifest(new URL("..", import.meta.url).pathname)!;

describe("Antigravity Adapter", () => {
  it("passes checkAdapter with 0 problems", () => {
    const { problems, checked } = checkAdapter(adapter, { bagManifest });
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(20);
  });

  it("declares identity, vendor, and requirements matching the pinned build", () => {
    expect(adapter.id).toBe("antigravity");
    expect(adapter.aliases).toEqual(["agy"]);
    expect(adapter.vendor).toBe("google");
    expect(adapter.defaultMode).toBe("hosted");

    const agyReq = adapter.requirements?.binary;
    expect(agyReq).toBeDefined();
    expect(agyReq?.recommendedVersion).toBe("1.3.6");
    expect(new RegExp(agyReq.versionPattern).test(`agy ${VERIFIED_ON}`)).toBe(true);
  });

  it("answers all three mode slots with valid implementations", () => {
    expect(adapter.modes.hosted).not.toBeNull();
    expect(adapter.modes.hosted?.start).toBeTypeOf("function");
    expect(adapter.modes.hosted?.adopt).toBeTypeOf("function");
    expect(adapter.modes.hosted?.guarantees).toMatchObject({
      capture: "total",
      delivery: "wake",
      steer: false,
      interrupt: true,
      gating: "hooks",
    });

    expect(adapter.modes.instrumented).not.toBeNull();
    expect(adapter.modes.instrumented?.plan).toBeTypeOf("function");
    expect(adapter.modes.instrumented?.guarantees).toMatchObject({
      capture: "post-hoc",
      delivery: "turn-end",
      gating: "hooks",
      keepsVendorUi: true,
    });

    expect(adapter.modes.guest).not.toBeNull();
    expect(adapter.modes.guest?.plan).toBeTypeOf("function");
    expect(adapter.modes.guest?.guarantees).toMatchObject({
      capture: "post-hoc",
      keepsVendorUi: true,
    });
  });

  it("plans a guest launch through adapter.modes.guest", async () => {
    const plan = await adapter.modes.guest!.plan({
      sessionId: "guest-plan-sess",
      cwd: "/repos/app",
      env: { GEMINI_API_KEY: "test-gemini-key" },
      mcpServers: {},
    });
    expect(plan.command).toMatch(/agy/);
    expect(plan.args).toContain("--add-dir");
    expect(plan.args).toContain("/repos/app");
    expect(plan.guarantees.capture).toBe("post-hoc");
  });

  it("declares native tools, offered models, and transcript support", () => {
    expect(adapter.tools.length).toBe(59);
    expect(adapter.offeredModels?.length).toBeGreaterThan(0);
    expect(adapter.listModels).toBeTypeOf("function");
    expect(adapter.transcript).toBeDefined();
    expect(adapter.transcript?.locate).toBeTypeOf("function");
    expect(adapter.transcript?.read).toBeTypeOf("function");
  });
});
