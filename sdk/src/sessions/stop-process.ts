import {withDeadline,DeadlineError} from "./deadline.js";
/** Structural so public session declarations remain usable without Node types. */
interface OwnedProcess {
 exitCode:number|null;
 signalCode:string|null;
 once(event:"exit",listener:()=>void):unknown;
 off(event:"exit",listener:()=>void):unknown;
 kill(signal?:string|number):boolean;
}
/** Signals only a child owned by the caller; never a shared service. */
export async function stopProcess(child:OwnedProcess,graceMs=1000,signal:string|number="SIGTERM"):Promise<void>{
 if(child.exitCode!==null||child.signalCode!==null)return;
 let done!:()=>void;const exited=new Promise<void>(resolve=>{done=resolve;child.once("exit",done);});
 try{child.kill(signal);try{await withDeadline(exited,graceMs);}catch(error){if(!(error instanceof DeadlineError))throw error;child.kill("SIGKILL");await withDeadline(exited,1000);}}
 finally{child.off("exit",done);}
}

/** A persisted engine may outlive its parent. Verify pid + birth time before each signal. */
export async function stopOwnedProcess(pid:number,stillOwned:()=>boolean,graceMs=1000):Promise<void> {
 if(!stillOwned())return;
 try{process.kill(pid,"SIGTERM");}catch(error){if((error as NodeJS.ErrnoException).code!=="ESRCH")throw error;return;}
 const deadline=performance.now()+graceMs;
 while(stillOwned()&&performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
 if(stillOwned())try{process.kill(pid,"SIGKILL");}catch(error){if((error as NodeJS.ErrnoException).code!=="ESRCH")throw error;}
}
