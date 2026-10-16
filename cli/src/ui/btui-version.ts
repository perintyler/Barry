import {statSync,accessSync,constants} from "node:fs";
import {join} from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
const cache=new Map<string,Promise<boolean>>();
export function supportsPendingSend(version:string):boolean {
 const match=/\bbtui\s+(\d+)\.(\d+)\.(\d+)/.exec(version);
 return !!match&&(Number(match[1])>0||Number(match[2])>=3);
}
export async function btuiSupportsPendingSend(env:NodeJS.ProcessEnv=process.env):Promise<boolean> {
 for(const dir of (env.PATH??"").split(":")){
  if(!dir)continue;const path=join(dir,"btui");
  try{
   accessSync(path,constants.X_OK);const stat=statSync(path);const key=`${path}:${stat.mtimeMs}:${stat.size}`;
   let result=cache.get(key);if(!result){cache.clear();result=promisify(execFile)(path,["--version"],{env,timeout:1000}).then(({stdout})=>supportsPendingSend(stdout),()=>false);cache.set(key,result);}
   return result;
  }catch{/* try next executable */}
 }
 return false;
}
