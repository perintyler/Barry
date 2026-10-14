import { describe, expect, it } from "vitest";
import {
  buildLlamaServerArgs,
  defaultGpuLayers,
  probeLlamaServer,
  LlamaServerSupervisor,
} from "./supervisor.js";
import { createLlamaBridge } from "./bridge.js";

describe("buildLlamaServerArgs", () => {
  it("builds standard arguments for llama-server", () => {
    const args = buildLlamaServerArgs({
      model: "/path/to/model.gguf",
      port: 8080,
      host: "127.0.0.1",
      ctxSize: 8192,
      gpuLayers: 33,
      extraArgs: ["--temp", "0.2"],
    });

    expect(args).toEqual([
      "-m",
      "/path/to/model.gguf",
      "--host",
      "127.0.0.1",
      "--port",
      "8080",
      "-c",
      "8192",
      "-ngl",
      "33",
      "--temp",
      "0.2",
    ]);
  });

  it("applies defaults for host, ctxSize, and gpuLayers", () => {
    const args = buildLlamaServerArgs({
      model: "/models/test.gguf",
      port: 9000,
    });

    expect(args).toEqual([
      "-m",
      "/models/test.gguf",
      "--host",
      "127.0.0.1",
      "--port",
      "9000",
      "-c",
      "4096",
      "-ngl",
      String(defaultGpuLayers()),
    ]);
  });
});

describe("probeLlamaServer", () => {
  it("probes health successfully against an active server", async () => {
    const bridge = await createLlamaBridge({ port: 0 });
    try {
      const isReady = await probeLlamaServer(bridge.url, 2000);
      expect(isReady).toBe(true);
    } finally {
      await bridge.close();
    }
  });

  it("returns false when the target is down", async () => {
    const isReady = await probeLlamaServer("http://127.0.0.1:59999", 500);
    expect(isReady).toBe(false);
  });
});

describe("LlamaServerSupervisor lifecycle", () => {
  it("computes url and v1Url correctly", () => {
    const supervisor = new LlamaServerSupervisor({
      model: "/path/to/m.gguf",
      port: 8080,
    });
    expect(supervisor.url).toBe("http://127.0.0.1:8080");
    expect(supervisor.v1Url).toBe("http://127.0.0.1:8080/v1");
    expect(supervisor.isRunning()).toBe(false);
  });
});
