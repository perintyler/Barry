import {beforeEach,afterEach,it,expect,vi} from "vitest";
const sessions=vi.hoisted(()=>({get:vi.fn(),list:vi.fn()}));
const target=vi.hoisted(()=>({current:vi.fn(()=>({kind:"owner"})),assertOwned:vi.fn()}));
vi.mock("@barry-rocks/sessions-bag/client",()=>({Sessions:sessions}));
vi.mock("@barry-rocks/sdk/services",()=>({getServiceUrl:()=>"http://127.0.0.1:4854"}));
vi.mock("../target.js",()=>({currentTarget:target.current,assertOwnedSession:target.assertOwned}));
import {sessionControlCommand} from "./session-control.js";
beforeEach(()=>{vi.clearAllMocks();target.current.mockReturnValue({kind:"owner"});target.assertOwned.mockReset();});afterEach(()=>vi.unstubAllGlobals());
it("refuses an ambiguous prefix before making a request",async()=>{sessions.get.mockResolvedValue(undefined);sessions.list.mockResolvedValue([{id:"abc1"},{id:"abc2"}]);const fetch=vi.fn();vi.stubGlobal("fetch",fetch);await expect(sessionControlCommand("stop","abc")).rejects.toThrow("Ambiguous");expect(fetch).not.toHaveBeenCalled();});
it("resolves a unique prefix and prints the interrupt outcome",async()=>{sessions.get.mockResolvedValue(undefined);sessions.list.mockResolvedValue([{id:"abc1"}]);const fetch=vi.fn(async()=>new Response(JSON.stringify({message:"Turn forced to stop"}),{status:200}));vi.stubGlobal("fetch",fetch);const log=vi.spyOn(console,"log").mockImplementation(()=>{});try{await sessionControlCommand("interrupt","abc");expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:4854/api/v1/sessions/abc1/interrupt",expect.objectContaining({method:"POST"}));expect(log).toHaveBeenCalledWith("Turn forced to stop");}finally{log.mockRestore();}});
it("names a missing session",async()=>{sessions.get.mockResolvedValue(undefined);sessions.list.mockResolvedValue([]);await expect(sessionControlCommand("stop","gone")).rejects.toThrow("Session not found");});
it("checks the resolved prefix owner before sending a control request",async()=>{
 sessions.get.mockResolvedValue(undefined);const row={id:"abc1",identity_id:2};sessions.list.mockResolvedValue([row]);
 target.current.mockReturnValue({kind:"identity",binding:{id:1}} as ReturnType<typeof target.current>);
 target.assertOwned.mockImplementation(()=>{throw Error("session belongs to another identity");});
 const fetch=vi.fn();vi.stubGlobal("fetch",fetch);
 await expect(sessionControlCommand("stop","abc")).rejects.toThrow("another identity");
 expect(target.assertOwned).toHaveBeenCalledWith(row,1);expect(fetch).not.toHaveBeenCalled();
});
