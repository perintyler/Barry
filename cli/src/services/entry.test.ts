import { expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { nodeTsArgv } from "@barry-rocks/sdk/internal/services";
it("hands launchd the real PID, filters ambient secrets, and delivers SIGTERM to the service", async () => {
  const root = mkdtempSync(join(tmpdir(), "barry-handoff-"));
  const home = join(root, "app-support");
  mkdirSync(home);
  mkdirSync(join(root, "config"));
  writeFileSync(join(root, "config", "barry.yaml"), "secrets:\n  DECLARED_SECRET:\n    in: .env\nservices:\n  fixture.api:\n    env: [DECLARED=installation-specific]\n");
  writeFileSync(join(home, "env"), "DECLARED_SECRET=owned-service-secret\nUNRELATED_SECRET=private-unselected\n");
  const fixture = join(root, "fixture.mjs");
  writeFileSync(
    fixture,
    'process.on("SIGTERM",()=>process.exit(0)); console.log(JSON.stringify({ pid:process.pid, secret:process.env.UNRELATED_SECRET, declared:process.env.DECLARED, bound:process.env.DECLARED_SECRET, home:process.env.BARRY_HOME, xdg:process.env.XDG_CONFIG_HOME, literal:process.env.LITERAL, empty:process.env.EMPTY, dispatcher:process.env.BARRY_HOOK_DISPATCHER })); setInterval(()=>{},1000);',
  );
  writeFileSync(
    join(home, "service-definitions.json"),
    JSON.stringify({
      "fixture.api": {
        key: "fixture.api",
        bag: "fixture",
        command: process.execPath,
        args: [fixture],
        cwd: root,
        env: [
          { name: "DECLARED", source: "value", value: "explicit" },
          { name: "LITERAL", source: "value", value: "$HOME/config" },
          { name: "EMPTY", source: "value", value: "" },
        ],
        secrets: ["DECLARED_SECRET"],
      },
    }),
  );
  const child = spawn(
    nodeTsArgv(join(import.meta.dirname, "entry.ts"))[0],
    [
      ...nodeTsArgv(join(import.meta.dirname, "entry.ts")).slice(1),
      home,
      "fixture.api",
    ],
    {
      env: {
        ...process.env,
        BARRY_HOME: root,
        XDG_CONFIG_HOME: join(root, "xdg-config"),
        BARRY_HOOK_DISPATCHER: join(root, "barry-hook.js"),
        UNRELATED_SECRET: "must-not-inherit",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = once(child, "exit");
  try {
    const data = await Promise.race([
      once(child.stdout, "data"),
      exited.then(() => {
        throw new Error("service exited before reporting its PID");
      }),
    ]);
    const observed = JSON.parse(String(data[0]));
    expect(observed).toEqual({
      pid: child.pid,
      declared: "installation-specific",
      bound: "owned-service-secret",
      home: root,
      xdg: join(root, "xdg-config"),
      literal: "$HOME/config",
      empty: "",
      dispatcher: join(root, "barry-hook.js"),
    });
    child.kill("SIGTERM");
    expect(await exited).toEqual([0, null]);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

it.each([".env", "vault", "bag-data"])("rejects a stale prepared %s source before executing or exposing credentials", source => {
  const root = mkdtempSync(join(tmpdir(), "barry-stale-service-"));
  const home = join(root, "app-support");
  mkdirSync(home);
  const marker = join(root, "started");
  const fixture = join(root, "fixture.mjs");
  writeFileSync(fixture, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "started");`);
  writeFileSync(join(home, "service-definitions.json"), JSON.stringify({ "fixture.api": {
    key: "fixture.api", bag: "fixture", command: process.execPath, args: [fixture], cwd: root,
    env: [{ name: "PRIVATE_KEY", source, required: true, item: "private", field: "password", file: "private" }],
  } }));
  try {
    const argv = nodeTsArgv(join(import.meta.dirname, "entry.ts"));
    const result = spawnSync(argv[0], [...argv.slice(1), home, "fixture.api"], {
      env: { ...process.env, BARRY_HOME: root, PRIVATE_KEY: "private-shell-canary" }, encoding: "utf8", timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("service environment must contain literal values");
    expect(result.stdout + result.stderr).not.toContain("private-shell-canary");
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
