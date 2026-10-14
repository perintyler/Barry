import { expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { antigravityTranscript } from "./transcript.js";

it("declares transcript locations without trusting the recorded file's parent", async () => {
  const roots = antigravityTranscript.roots;
  expect(roots).toBeTypeOf("function");
  if (!roots) throw new Error("transcript roots are required for shipped readers");
  const locations = await roots({ metadata: { transcript_path: "/unrelated/private.jsonl" } });
  expect(locations.length).toBeGreaterThan(0);
  expect(locations).not.toContain("/unrelated");
  expect(locations.some(root => root.startsWith(homedir()) || root.includes("app-support"))).toBe(true);
});

it("declares the configured adapter location", async () => {
  const roots = antigravityTranscript.roots;
  if (!roots) throw new Error("transcript roots are required");
  expect(await roots({ metadata: { antigravity_data_dir: "/configured/adapter" } })).toContain(join("/configured/adapter", "brain"));
});
