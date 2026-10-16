import { Worker } from "node:worker_threads";
import type {PromptEnqueueResult} from "./session-records.js";
import type { WsMessageInput } from "./session-records.js";

/** The worker reuses persistOne, with its own connection and correlation maps.
 * Its busy_timeout and disk I/O cannot block the socket/model event loop. */
const source = `
const {parentPort,workerData}=require('node:worker_threads');
(async()=>{
 process.env.BARRY_SESSIONS_DB=workerData.path;
 const {tsImport}=await import(workerData.tsx);
 const [{persistOne},{jsonColumnPlugin},{default:Database},{Kysely,SqliteDialect}]=await Promise.all([
   tsImport(workerData.messages,workerData.messages),tsImport(workerData.plugin,workerData.plugin),
   import(workerData.sqlite),import(workerData.kysely)
 ]);
 const sqlite=new Database(workerData.path,{fileMustExist:true});
 sqlite.pragma('journal_mode=WAL');sqlite.pragma('foreign_keys=ON');
 sqlite.pragma('synchronous=NORMAL');sqlite.pragma('busy_timeout=5000');
 const db=new Kysely({dialect:new SqliteDialect({database:sqlite}),plugins:[jsonColumnPlugin()]});
 let tail=Promise.resolve();
 const rebased=new Map();
 parentPort.on('message',job=>{
   tail=tail.then(async()=>{
     try {
       let sequence=null;
       if(job.operation==='prompt') {
         const {queuePromptOrderedSqlite}=await tsImport(workerData.writes,workerData.writes);
         const prompt=queuePromptOrderedSqlite(job.sessionId,job.content,job.options);
         parentPort.postMessage({id:job.id,prompt});
         return;
       } else if(job.operation==='status') {
         sqlite.prepare('UPDATE sessions SET status=?,started_at=COALESCE(started_at,?) WHERE id=?').run(job.status,job.startedAt??null,job.sessionId);
       } else {
         sqlite.exec('BEGIN IMMEDIATE');
         try {
           const message={...job.message};
           const next=()=>sqlite.prepare('SELECT COALESCE(MAX(sequence),-1)+1 AS seq FROM messages WHERE session_id=?').get(job.sessionId).seq;
           if(Number.isInteger(message.sequence) && rebased.has(job.sessionId) && message.sequence<=rebased.get(job.sessionId)) message.sequence=next();
           const existing=message.dedupeKey?sqlite.prepare('SELECT sequence FROM messages WHERE session_id=? AND dedupe_key=?').get(job.sessionId,message.dedupeKey):null;
           try {sequence=existing?.sequence??await persistOne(db,job.sessionId,message,job.harnessSessionId,job.modelId,'engine');}
           catch(error) {
             if(!/SQLITE_CONSTRAINT_UNIQUE|UNIQUE constraint failed/i.test(String(error)))throw error;
             message.sequence=next();
             sequence=await persistOne(db,job.sessionId,message,job.harnessSessionId,job.modelId,'engine');
             rebased.set(job.sessionId,message.sequence);
           }
           if(rebased.has(job.sessionId) && typeof sequence==='number')rebased.set(job.sessionId,sequence);
           sqlite.exec('COMMIT');
         } catch(error) {sqlite.exec('ROLLBACK');throw error;}
       }
       parentPort.postMessage({id:job.id,sequence});
     }
     catch(error){parentPort.postMessage({id:job.id,error:error.message,code:error.code});}
   });
 });
 parentPort.postMessage({ready:true});
})().catch(error=>{throw error});
`;
interface Reply {id?:number;sequence?:number|null;prompt?:PromptEnqueueResult;error?:string;code?:string}
interface Pending { resolve(value:Reply):void; reject(error:Error):void }
interface Writer { worker:Worker; pending:Map<number,Pending>; next:number; idle?:ReturnType<typeof setTimeout> }
const writers=new Map<string,Writer>();
function writer(path:string):Writer {
  const existing=writers.get(path);if(existing)return existing;
  const worker=new Worker(source,{eval:true,execArgv:[],workerData:{path,
    tsx:import.meta.resolve("tsx/esm/api"),
    messages:import.meta.resolve("@barry-rocks/sessions-bag/store/messages"),
    writes:import.meta.resolve("@barry-rocks/sessions-bag/store/sessions-sqlite-writes"),
    plugin:import.meta.resolve("@barry-rocks/sessions-bag/store/sessions-json-plugin"),
    sqlite:import.meta.resolve("better-sqlite3"),kysely:import.meta.resolve("kysely"),
  }});
  const value:Writer={worker,pending:new Map(),next:0};writers.set(path,value);
  const failed=(error:Error)=>{
    if(value.idle)clearTimeout(value.idle);
    if(writers.get(path)===value)writers.delete(path);
    for(const job of value.pending.values())job.reject(error);value.pending.clear();worker.unref();
  };
  worker.on("error",failed);worker.on("exit",code=>failed(new Error(`Recording worker exited (${code})`)));
  worker.on("message",(reply:Reply)=>{
    if(reply.id===undefined)return;
    const job=value.pending.get(reply.id);if(!job)return;value.pending.delete(reply.id);
    if(reply.error)job.reject(Object.assign(new Error(reply.error),{code:reply.code}));else job.resolve(reply);
    if(!value.pending.size) {
      worker.unref();value.idle=setTimeout(()=>{
        if(writers.get(path)===value && !value.pending.size){writers.delete(path);void worker.terminate();}
      },60_000);value.idle.unref();
    }
  });
  worker.unref();return value;
}
function submit(path:string,job:Record<string,unknown>):Promise<Reply> {
  const value=writer(path);if(value.idle)clearTimeout(value.idle);value.idle=undefined;
  const id=++value.next;value.worker.ref();
  return new Promise((resolve,reject)=>{
    value.pending.set(id,{resolve,reject});
    try {value.worker.postMessage({id,...job});}
    catch(error){value.pending.delete(id);if(!value.pending.size)value.worker.unref();reject(error);}
  });
}
export function persistInThread(path:string,sessionId:string,message:WsMessageInput,harnessSessionId:string|null|undefined,modelId:number|null):Promise<number|null> {
  return submit(path,{sessionId,message,harnessSessionId,modelId}).then(reply=>reply.sequence??null);
}
export async function recordSessionStateInThread(path:string,sessionId:string,status:string,startedAt?:Date|null):Promise<void> {
  await submit(path,{operation:"status",sessionId,status,startedAt:startedAt?.toISOString()});
}
/** Used when a store is closed or replaced, after its queues drain. */
export async function closeRecordingWorkers():Promise<void> {
  const current=[...writers.values()];writers.clear();await Promise.all(current.map(async value=>{await value.worker.terminate();}));
}

export async function enqueuePromptInThread(path:string,sessionId:string,content:string,options:{sequence?:number;clientMessageId?:string;source?:"web_prompt"|"session";fromSession?:string}={}):Promise<PromptEnqueueResult>{
 const reply=await submit(path,{operation:"prompt",sessionId,content,options});
 if(!reply.prompt)throw new Error("Recording worker omitted its prompt receipt");
 return reply.prompt;
}
