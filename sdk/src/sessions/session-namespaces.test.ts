import {it,expect,vi,afterEach} from "vitest";
import {resolveSessionNamespaces} from "./session-namespaces.js";
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
it("identity opt-in splits while hosted defaults override a legacy service flag",async()=>{
 vi.stubEnv("BARRY_NAMESPACE_SPLIT","1");const request=vi.fn(async()=>new Response(JSON.stringify({namespaces:["git","barry"]})));vi.stubGlobal("fetch",request);
 expect(await resolveSessionNamespaces("session",{enabled:false})).toEqual([]);expect(request).not.toHaveBeenCalled();
 vi.stubEnv("BARRY_NAMESPACE_SPLIT","false");expect(await resolveSessionNamespaces("session",{enabled:true,baseUrl:"http://127.0.0.1:4807"})).toEqual(["barry","git"]);expect(request).toHaveBeenCalledOnce();
});
