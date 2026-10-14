import { afterEach, describe, expect, it } from "vitest";
import { useTestInstance } from "./test-instance.js";
import { serviceAddress } from "./service-registry.js";

describe("a test instance", () => {
  const saved = process.env.BARRY_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.BARRY_HOME;
    else process.env.BARRY_HOME = saved;
  });

  it("has its own home, the core services at dead ports, and the services asked for", () => {
    const home = useTestInstance({ "lists.web": "http://127.0.0.1:4885" });
    expect(process.env.BARRY_HOME).toBe(home);
    expect(serviceAddress("sessions.api")).toBe("http://127.0.0.1:1");
    expect(serviceAddress("lists.web")).toBe("http://127.0.0.1:4885");
  });
});
