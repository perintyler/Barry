import { execFile } from "node:child_process";
/** Count command names only; process arguments may contain credentials/prompts. */
export function claudeProcessCount():Promise<number|null> {
  return new Promise(resolve=>execFile("ps",["-axo","pid=,ppid=,comm="],{timeout:1000,maxBuffer:1024*1024},(error,stdout)=>{
    if(error){resolve(null);return;}
    const rows=stdout.split("\n").map(line=>line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean);
    const owned=new Set([process.pid]);let changed=true;while(changed){changed=false;for(const row of rows)if(owned.has(Number(row![2]))&&!owned.has(Number(row![1]))){owned.add(Number(row![1]));changed=true;}}
    resolve(rows.filter(row=>owned.has(Number(row![1]))&&/(^|\/)claude(?:$|\s|\/versions\/)/.test(row![3]!)).length);
  }));
}
