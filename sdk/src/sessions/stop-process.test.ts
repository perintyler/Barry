import {it,expect} from "vitest";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {stopProcess} from "./stop-process.js";
it("kills only its owned child when graceful termination is ignored, and repeats safely",async()=>{
 const child=spawn(process.execPath,["-e","process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"]);
 try{await once(child.stdout!,"data");await stopProcess(child,20);expect(child.signalCode).toBe("SIGKILL");await stopProcess(child,20);}finally{if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");}
});
