import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { installationEnvironment } from "./installation-environment.js";
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function config(text: string): string {
  const directory = mkdtempSync(join(tmpdir(), "barry-service-config-"));
  directories.push(directory);
  const path = join(directory, "barry.yaml");
  writeFileSync(path, text);
  return path;
}
const defaults = [{ name: "MODE", source: "value" as const, value: "default" }];
it("reads installation overrides freshly and preserves literal values and service isolation", () => {
  const path = config('services:\n  app.api:\n    env: [MODE=$HOME/custom=exact]\n');
  expect(installationEnvironment("app.api", defaults, [], path)[0].value).toBe("$HOME/custom=exact");
  expect(installationEnvironment("other.api", defaults, [], path)).toEqual(defaults);
  writeFileSync(path, 'services:\n  app.api:\n    env: [MODE=]\n');
  expect(installationEnvironment("app.api", defaults, [], path)[0].value).toBe("");
  expect(defaults[0].value).toBe("default");
});
it.each(["TOKEN=private", "PATH=/custom", "MODE=one, MODE=two", "MODE"])("rejects undeclared or malformed overrides: %s", value => {
  const path = config(`services:\n  app.api:\n    env: [${value}]\n`);
  expect(() => installationEnvironment("app.api", defaults, ["TOKEN"], path)).toThrow();
});
it("refuses to override a credential even when a prepared definition also declares a literal", () => {
  const path = config('services:\n  app.api:\n    env: [MODE=override]\n');
  expect(() => installationEnvironment("app.api", defaults, ["MODE"], path)).toThrow("not a declared nonsecret value");
});
it("keeps the hosted namespace manifest value despite a legacy installation override",()=>{
 const path=config('services:\n  sessions.api:\n    env: [BARRY_NAMESPACE_SPLIT=1]\n');
 expect(installationEnvironment("sessions.api",[{name:"BARRY_NAMESPACE_SPLIT",source:"value",value:"false"}],[],path)[0].value).toBe("false");
});
