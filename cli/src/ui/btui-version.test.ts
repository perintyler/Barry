import {it,expect} from "vitest";
import {supportsPendingSend} from "./btui-version.js";
it("gates BTUI_SEND on a compatible client",()=>{expect(supportsPendingSend("btui 0.2.0")).toBe(false);expect(supportsPendingSend("btui 0.3.0")).toBe(true);expect(supportsPendingSend("btui 1.0.0")).toBe(true);expect(supportsPendingSend("garbled")).toBe(false);});
