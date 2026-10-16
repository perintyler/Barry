import type {Session,SessionEvent} from "../index.js";
import {withDeadline} from "../deadline.js";

// This helper is also exported by the browser-compatible SDK testing entry.
function assert(condition:unknown):asserts condition {
 if(!condition)throw new Error("Session contract assertion failed");
}
function equal(actual:unknown,expected:unknown):void {
 if(!Object.is(actual,expected))throw new Error(`Session contract expected ${String(expected)}, received ${String(actual)}`);
}

export interface SessionContractFixture {
  session:Session;
  /** Wait until the fake provider has accepted this turn. */
  ready():Promise<void>;
  /** Complete the provider turn, including the case where close already ran. */
  complete():void|Promise<void>;
  resourcesReleased():boolean|Promise<boolean>;
}
/** Shared assertions run against each adapter's real session and controllable provider fake. */
export function describeSessionContract(name:string, factory:()=>SessionContractFixture|Promise<SessionContractFixture>, suite:{describe:(name:string,body:()=>void)=>unknown;it:(name:string,body:()=>Promise<void>)=>unknown}):void {
  const collect=async(reader:AsyncIterator<SessionEvent>)=>{
    const events:SessionEvent[]=[];
    for(;;){const next=await withDeadline(reader.next(),2000);if(next.done)return events;events.push(next.value);if(next.value.type==="done")return events;}
  };
  suite.describe(`${name}: shared Session contract`,()=>{
    suite.it("normal turn has exactly one terminal done",async()=>{
      const f=await factory();try{const reader=f.session.events()[Symbol.asyncIterator]();await f.session.deliver("first");await f.ready();await f.complete();equal((await collect(reader)).filter(e=>e.type==="done").length,1);}finally{await withDeadline(f.session.close(),2000);}
    });
    suite.it("interrupt completes one turn and the next turn works",async()=>{
      const f=await factory();try{const reader=f.session.events()[Symbol.asyncIterator]();await f.session.deliver("first");await f.ready();const interrupt=f.session.interrupt();await f.complete();await withDeadline(interrupt,2000);equal((await collect(reader)).filter(e=>e.type==="done").length,1);await f.session.deliver("second");await f.ready();await f.complete();const next=await collect(reader);equal(next.filter(e=>e.type==="done").length,1);assert(next.some(e=>e.type==="text"||e.type==="partial"||e.type==="result"));}finally{await withDeadline(f.session.close(),2000);}
    });
    suite.it("close ends the open reader and releases owned resources",async()=>{
      const f=await factory();const reader=f.session.events()[Symbol.asyncIterator]();try{await f.session.deliver("first");await f.ready();await withDeadline(f.session.close(),2000);equal((await collect(reader)).filter(e=>e.type==="done").length,1);equal((await withDeadline(reader.next(),2000)).done,true);equal(await f.resourcesReleased(),true);}finally{await f.session.close();}
    });
    suite.it("repeated cancellation and late completion cannot duplicate done",async()=>{
      const f=await factory();const reader=f.session.events()[Symbol.asyncIterator]();try{await f.session.deliver("first");await f.ready();const interrupt=f.session.interrupt().catch(()=>{});await withDeadline(f.session.close(),2000);await f.session.close();await f.session.interrupt().catch(()=>{});await f.complete();await withDeadline(interrupt,2000);const events=await collect(reader);equal(events.filter(e=>e.type==="done").length,1);equal((await withDeadline(reader.next(),2000)).done,true);}finally{await f.session.close();}
    });
  });
}
