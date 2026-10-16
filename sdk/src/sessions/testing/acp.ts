import type {PromptResponse} from "@agentclientprotocol/sdk";
import type {Guarantees} from "../../adapters/harnesses/index.js";
import {openAcpSession} from "../../acp/session.js";
import {deferred} from "../deadline.js";
import type {SessionContractFixture} from "./contract.js";

/** Controllable peer using the protocol SDK on both sides of an in-memory transport. */
export async function acpSessionContractFixture(guarantees:Guarantees):Promise<SessionContractFixture> {
 const {agent,methods,ndJsonStream,PROTOCOL_VERSION}=await import("@agentclientprotocol/sdk");
 let released=false;let current=deferred<PromptResponse>();let admitted=deferred<void>();
 const toAgent=new TransformStream<Uint8Array,Uint8Array>();
 const toClient=new TransformStream<Uint8Array,Uint8Array>();
 const peer=agent({name:"contract"})
  .onRequest(methods.agent.initialize,()=>({protocolVersion:PROTOCOL_VERSION,agentCapabilities:{}}))
  .onRequest(methods.agent.session.new,()=>({sessionId:"contract"}))
  .onRequest(methods.agent.session.prompt,()=>{current=deferred();admitted.resolve();return current.promise;})
  .onNotification(methods.agent.session.cancel,()=>{})
  .connect(ndJsonStream(toClient.writable,toAgent.readable));
 const session=await openAcpSession({config:{sessionId:"contract",cwd:"/tmp",env:{},mcpServers:{}},guarantees,
  connect:app=>app.connect(ndJsonStream(toAgent.writable,toClient.readable)),
  release:()=>{released=true;peer.close();},
 });
 return {session,ready:()=>admitted.promise,complete:()=>{current.resolve({stopReason:"end_turn"});admitted=deferred();},resourcesReleased:()=>released};
}
