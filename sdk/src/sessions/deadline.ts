/** Bounds waits; cancellation of the underlying work remains the owner's job. */
export class DeadlineError extends Error { constructor(readonly timeoutMs:number){super(`Deadline exceeded (${timeoutMs} ms)`);this.name="DeadlineError";} }
export function envMs(name:string,fallback:number):number {
  const raw=process.env[name];const n=raw?.trim()?Number(raw):NaN;
  return Number.isFinite(n)&&n>0&&n<=2_147_483_647?n:fallback;
}
export function deferred<T=void>() {let resolve!:(value:T|PromiseLike<T>)=>void;let reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
export async function withDeadline<T>(work:PromiseLike<T>,timeoutMs:number):Promise<T> {
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new DeadlineError(timeoutMs)),timeoutMs);})]);}
 finally{if(timer)clearTimeout(timer);}
}
export async function forcedAfter<T>(work:PromiseLike<T>,timeoutMs:number,force:()=>T|Promise<T>):Promise<T> {
 try{return await withDeadline(work,timeoutMs);}catch(error){if(!(error instanceof DeadlineError))throw error;return force();}
}
export async function untilAborted<T>(work:PromiseLike<T>,signal?:AbortSignal):Promise<T> {
 if(!signal)return work;
 if(signal.aborted){void Promise.resolve(work).catch(()=>{});throw signal.reason??new Error("Aborted");}
 let cancel!:()=>void;
 try{return await Promise.race([work,new Promise<never>((_,reject)=>{cancel=()=>reject(signal.reason??new Error("Aborted"));signal.addEventListener("abort",cancel,{once:true});})]);}
 finally{signal.removeEventListener("abort",cancel);}
}
