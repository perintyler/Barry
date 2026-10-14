import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

function ui() {
  // Exercise the actual client request handlers, without starting its DOM boot loop.
  const modules = ["state.js", "api.js", "routing.js"].map(file => readFileSync(new URL(`../web/${file}`, import.meta.url), "utf8").replace(/^export /gm, "")).join("\n");
  const source = modules + "\n" + readFileSync(new URL("../web/app.js", import.meta.url), "utf8").replace(/^import .*;$/gm, "").split('$("#new-run").addEventListener')[0];
  const pending: ((value: unknown) => void)[] = [];
  const context = createContext({ AbortSignal, URLSearchParams, location: { hash: "#runs/A" }, document: { querySelector: () => ({}) }, fetch: () => new Promise(resolve => pending.push(body => resolve({ status: 200, ok: true, json: async () => body }))) });
  runInContext(source, context);
  runInContext('state.run = {run: {id: "A"}}; renderCurrentDetail = () => {};', context);
  return { context, pending, run: (code: string) => runInContext(code, context) };
}
it("discards delayed history after navigating to another run", async () => {
  const { run, pending } = ui();
  const request = run("loadHistory()");
  run('location.hash = "#runs/B"; state.generation++; state.run = {run: {id: "B"}}; state.events = [];');
  pending[0]({ items: [{ sequence: 1, type: "OldRun" }], nextCursor: null });
  await request;
  expect(run("state.events.length")).toBe(0);
});
it("serializes history pagination and deduplicates repeated sequences", async () => {
  const { run, pending } = ui();
  run('state.events = [{sequence: 1}];');
  const first = run("loadHistory()"), second = run("loadHistory()");
  expect(pending).toHaveLength(1);
  pending[0]({ items: [{ sequence: 1 }, { sequence: 2 }], nextCursor: null });
  await Promise.all([first, second]);
  expect(run("JSON.stringify(state.events.map(e => e.sequence))")).toBe("[1,2]");
});
