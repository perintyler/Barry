import { Sessions } from "@barry-rocks/sessions-bag/client";
import {getServiceUrl} from "@barry-rocks/sdk/services";
import {currentTarget,assertOwnedSession} from "../target.js";
import {CliError} from "../lib/cli-error.js";

export async function sessionControlCommand(kind:"stop"|"interrupt", id:string):Promise<void> {
  const exact=await Sessions.get(id);
  const matches=exact?[exact]:(await Sessions.list({limit:10000})).filter(row=>row.id.startsWith(id));
  if(matches.length!==1)throw new CliError(matches.length?`Ambiguous session prefix: ${id}`:`Session not found: ${id}`,1);
  const row=matches[0]!;const target=currentTarget();
  if(target.kind==="identity")assertOwnedSession(row,target.binding.id);
  const response=await fetch(`${getServiceUrl("api")}/api/v1/sessions/${encodeURIComponent(row.id)}/${kind}`,{
    method:"POST",headers:process.env.BARRY_SECRET?{Authorization:`Bearer ${process.env.BARRY_SECRET}`}:{},signal:AbortSignal.timeout(15_000),
  });
  const body=await response.json() as {message?:string;error?:string;recordingPending?:boolean};
  if(!response.ok)throw new CliError(body.error??`HTTP ${response.status}`,1);
  console.log(body.message??`Session ${kind} requested`);
  if(body.recordingPending)console.warn("Transcript still draining");
}
