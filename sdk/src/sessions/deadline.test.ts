import {it,expect,vi,afterEach} from "vitest";
import {envMs,withDeadline,deferred,untilAborted} from "./deadline.js";
afterEach(()=>vi.unstubAllEnvs());
it("validates bounded millisecond environment values",()=>{for(const value of ["","abc","0","-1","Infinity","2147483648"]){vi.stubEnv("TEST_MS",value);expect(envMs("TEST_MS",17)).toBe(17);}vi.stubEnv("TEST_MS","42");expect(envMs("TEST_MS",17)).toBe(42);});
it("bounds hung work and safely observes late rejection",async()=>{const work=deferred();await expect(withDeadline(work.promise,5)).rejects.toThrow("Deadline exceeded");work.reject(new Error("late"));});
it("cancels a hung iterator read",async()=>{const abort=new AbortController();const work=deferred();const read=untilAborted(work.promise,abort.signal);abort.abort();await expect(read).rejects.toBeDefined();work.reject(new Error("late"));});
