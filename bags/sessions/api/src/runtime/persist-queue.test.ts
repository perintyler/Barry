import { describe,it,expect,vi,afterEach } from "vitest";
import { PersistQueue,PersistenceBacklogError } from "./persist-queue.js";
afterEach(()=>vi.useRealTimers());
describe("bounded durable recording",()=>{
 it("keeps delivery independent, retains bytes, rejects new admission and drains FIFO",async()=>{
  let release!:()=>void; const gate=new Promise<void>(r=>release=r); const written:number[]=[];const notice=vi.fn();
  const q=new PersistQueue<number>(notice,5,100);
  q.enqueue(1,4,async()=>{await gate;written.push(1);});q.enqueue(2,3,async()=>{written.push(2);});
  expect(q.pending()).toEqual([1,2]);expect(q.bytes).toBe(7);expect(()=>q.assertAdmission()).toThrow(PersistenceBacklogError);
  expect(await q.flush(5)).toBe(false);expect(q.pending()).toEqual([1,2]);
  release();expect(await q.flush()).toBe(true);expect(written).toEqual([1,2]);expect(q.bytes).toBe(0);
  expect(notice.mock.calls.map(c=>c[0])).toEqual([true,false]);expect(()=>q.assertAdmission()).not.toThrow();
 });
 it("retries the same head after failure, without losing later rows",async()=>{
  let attempts=0; const writes:number[]=[]; const q=new PersistQueue<number>(vi.fn());
  q.enqueue(1,10,async()=>{if(++attempts===1)throw Error("locked");writes.push(1);});
  q.enqueue(2,10,async()=>{writes.push(2);});
  expect(await q.flush(1000)).toBe(true);expect(attempts).toBe(2);expect(writes).toEqual([1,2]);expect(PersistQueue.bytes).toBe(0);
 });
});
it("clears unique-conflict admission failure once recovery drains the retained FIFO",async()=>{
 let attempts=0;const writes:number[]=[];const q=new PersistQueue<number>(vi.fn());
 q.enqueue(1,5,async()=>{if(++attempts===1)throw Error("SQLITE_CONSTRAINT_UNIQUE");writes.push(1);});
 q.enqueue(2,7,async()=>{writes.push(2);});
 await new Promise(resolve=>setTimeout(resolve,10));expect(()=>q.assertAdmission()).toThrow();
 expect(await q.flush(1000)).toBe(true);expect(writes).toEqual([1,2]);expect(q.bytes).toBe(0);expect(()=>q.assertAdmission()).not.toThrow();
});
