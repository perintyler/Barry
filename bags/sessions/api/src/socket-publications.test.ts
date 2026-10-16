import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticateCredential } from "@barry-rocks/sdk/internal/auth";
import { SocketPublications } from "./socket-publications.js";

class Transport extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  published: string[] = [];
  paused = false;
  sent: (() => void) | undefined;
  callbacks: Array<(error?: Error) => void> = [];
  close = vi.fn((_code: number, _reason: string) => { this.readyState = 3; this.emit("close"); });
  send(data: string, callback: (error?: Error) => void): void {
    this.published.push(data); this.sent?.();
    if (this.paused) this.callbacks.push(callback);
    else queueMicrotask(() => callback());
  }
}
const senders: SocketPublications[] = [];
afterEach(() => { for (const sender of senders.splice(0)) sender.dispose(); });
async function create(options: { maxBytes?: number; maxFrames?: number; onSent?: (bytes: number, queuedAt: number) => void } = {}, verifier?: () => unknown) {
  const transport = new Transport();
  const authorization = await authenticateCredential("fixture", { verifyCredential: verifier ?? (() => ({ kind: "installation", actorId: 1, credentialId: "installation" })) });
  const sender = new SocketPublications(transport, authorization!, options); senders.push(sender);
  return { sender, transport };
}
describe("authorized socket publications", () => {
  it("keeps publication order and stops between frames when the original credential changes", async () => {
    let active = true;
    const { sender, transport } = await create({}, () => active ? { kind: "installation", actorId: 1, credentialId: "installation" } : null);
    transport.sent = () => { active = false; sender.invalidateAuthorization(); };
    expect(sender.send("first")).toBe(true); expect(sender.send("second")).toBe(true);
    await vi.waitFor(() => expect(transport.close).toHaveBeenCalledWith(1008, "Authorization unavailable"));
    expect(transport.published).toEqual(["first"]);
    expect(sender.bufferedAmount).toBe(0);
    expect(sender.send("later")).toBe(false);
  });
  it("does not advance the queue until the native send callback finishes", async () => {
    const { sender, transport } = await create(); transport.paused = true;
    sender.send("one"); sender.send("two");
    await vi.waitFor(() => expect(transport.published).toEqual(["one"]));
    expect(sender.bufferedAmount).toBe(6);
    transport.callbacks.shift()!();
    await vi.waitFor(() => expect(transport.published).toEqual(["one", "two"]));
    transport.callbacks.shift()!();
    await vi.waitFor(() => expect(sender.bufferedAmount).toBe(0));
  });
  it.each([
    { limits: { maxBytes: 7 }, frames: ["four", "five"] },
    { limits: { maxFrames: 2 }, frames: ["", "", ""] },
  ])("bounds pending publications including empty frames", async ({ limits, frames }) => {
    let pending = false;
    const { sender, transport } = await create(limits, () => pending ? new Promise(() => {}) : { kind: "installation", actorId: 1, credentialId: "installation" });
    pending = true;
    for (const frame of frames.slice(0, -1)) expect(sender.send(frame)).toBe(true);
    expect(sender.send(frames.at(-1)!)).toBe(false);
    await vi.waitFor(() => expect(transport.close).toHaveBeenCalledExactlyOnceWith(1013, "Consumer is behind; reconnect"));
    expect(transport.published).toEqual([]);
    expect(sender.bufferedAmount).toBe(0);
  });
  it("includes native buffered bytes when admitting another publication", async () => {
    const { sender, transport } = await create({ maxBytes: 10 });
    transport.bufferedAmount = 9;
    expect(sender.send("no")).toBe(false);
    expect(transport.published).toEqual([]);
    expect(transport.close).toHaveBeenCalledWith(1013, expect.any(String));
  });
  it("drops queued frames on disconnect while an uncooperative verifier is pending", async () => {
    let pending = false, resolve!: (value: unknown) => void;
    const principal = { kind: "installation", actorId: 1, credentialId: "installation" };
    const { sender, transport } = await create({}, () => pending ? new Promise(done => { resolve = done; }) : principal);
    pending = true; sender.send("private"); sender.send("later");
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    transport.readyState = 3; transport.emit("close");
    resolve(principal);
    await Promise.resolve(); await Promise.resolve();
    expect(transport.published).toEqual([]); expect(sender.bufferedAmount).toBe(0);
  });
  it("releases a pending native write and discards later frames on disconnect", async () => {
    const { sender, transport } = await create(); transport.paused = true;
    sender.send("first"); sender.send("second");
    await vi.waitFor(() => expect(transport.published).toEqual(["first"]));
    transport.readyState = 3; transport.emit("close");
    transport.callbacks.shift()!();
    await Promise.resolve(); await Promise.resolve();
    expect(transport.published).toEqual(["first"]); expect(sender.bufferedAmount).toBe(0);
  });
  it("closes after a native write fails without publishing subsequent frames", async () => {
    const { sender, transport } = await create(); transport.paused = true;
    sender.send("first"); sender.send("second");
    await vi.waitFor(() => expect(transport.published).toEqual(["first"]));
    transport.callbacks.shift()!(new Error("Private transport details"));
    await vi.waitFor(() => expect(transport.close).toHaveBeenCalledWith(1011, "Publication failed"));
    expect(transport.published).toEqual(["first"]);
  });
  it("cannot be used as an unscoped publisher for a device principal", async () => {
    const authorization = await authenticateCredential("fixture", { verifyCredential: () => ({ kind: "device", actorId: 1, credentialId: "device", scopes: ["sessions:read"], identityIds: [1] }) });
    expect(() => new SocketPublications(new Transport(), authorization!)).toThrow("Installation publication authorization required");
    authorization!.dispose();
  });
});

it("reports timing only after native transport completion", async () => {
  const onSent=vi.fn(), completed=vi.fn();
  const {sender,transport}=await create({onSent}); transport.paused=true;
  sender.publish("abc",completed);
  await vi.waitFor(()=>expect(transport.published).toEqual(["abc"]));
  expect(onSent).not.toHaveBeenCalled();expect(completed).not.toHaveBeenCalled();
  transport.callbacks.shift()!();
  await vi.waitFor(()=>expect(completed).toHaveBeenCalledOnce());
  expect(onSent).toHaveBeenCalledWith(3,expect.any(Number));
});

it("reuses authorization within a second and invalidates immediately",async()=>{
 const verify=vi.fn(()=>({kind:"installation",actorId:1,credentialId:"installation"}));
 const {sender,transport}=await create({},verify);verify.mockClear();
 sender.send(JSON.stringify({type:"partial",content:"one"}));sender.send(JSON.stringify({type:"partial",content:"two"}));await vi.waitFor(()=>expect(transport.published).toHaveLength(2));
 expect(verify).toHaveBeenCalledTimes(1);
 sender.invalidateAuthorization();sender.send(JSON.stringify({type:"partial",content:"three"}));await vi.waitFor(()=>expect(transport.published).toHaveLength(3));expect(verify).toHaveBeenCalledTimes(2);
});
it("coalesces adjacent deltas under soft pressure without crossing a barrier",async()=>{
 const {sender,transport}=await create();transport.paused=true;
 sender.send("hold");await vi.waitFor(()=>expect(transport.published).toHaveLength(1));
 for(let i=0;i<100;i++) sender.send(JSON.stringify({type:"partial",sessionId:"s",content:"x"}));
 sender.send(JSON.stringify({type:"tool_start",sessionId:"s",toolUseId:"t"}));
 sender.send(JSON.stringify({type:"partial",sessionId:"s",content:"after"}));
 transport.paused=false;transport.callbacks.shift()!();
 await vi.waitFor(()=>expect(transport.published.at(-1)).toContain("after"));
 const frames=transport.published.slice(1).map(x=>JSON.parse(x));
 expect(frames.filter(x=>x.type==="partial").map(x=>x.content).join("")).toBe("x".repeat(100)+"after");
 expect(frames.length).toBeLessThan(40);expect(transport.close).not.toHaveBeenCalled();expect(frames.at(-2)?.type).toBe("tool_start");
});
