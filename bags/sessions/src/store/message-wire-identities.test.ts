import {it,expect} from "vitest";
import {rowToWireMessage} from "./session-helpers.js";
it.each(["text","init","error","result","summary","tool_start"])("retains a corrected durable identity for %s replay",kind=>{
 const wire=rowToWireMessage({type:kind==="tool_start"?"tool_call":"message",dedupe_key:"engine:stable",sequence:7,role:"assistant",content:[{type:"text",text:"body"}],metadata:{ws_type:kind},input:{},result:null},"session",false);
 expect(wire).toMatchObject({type:kind,dedupeKey:"engine:stable",sequence:7});
});
