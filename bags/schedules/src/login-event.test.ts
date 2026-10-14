import { describe, expect, it } from "vitest";
import { loginEventId } from "./login-event.js";
const boot = "4A884579-ADB6-4509-B8DF-BDBF19917658";
const domain = "gui/501 = {\n type = login\n security context = {\n uid = 501\n asid = 100016\n }\n}";
function mac(text = domain, uuid = boot) {
  return loginEventId({ platform: "darwin", uid: 501, run: command => command === "/bin/launchctl" ? text : uuid });
}
describe("verified login events", () => {
  it("uses the Mac audit session, user and boot UUID", () => {
    expect(mac()).toBe(`darwin:${boot}:501:100016`);
    expect(mac(domain.replace("100016", "100017"))).not.toBe(mac());
    expect(mac(domain, "5A884579-ADB6-4509-B8DF-BDBF19917658")).not.toBe(mac());
  });
  it.each([domain.replace("type = login", "type = user"), domain.replace("uid = 501", "uid = 502"), domain.replace("asid = 100016", "asid = 0"), "missing domain"])("rejects unverifiable Mac domain %s", text => {
    expect(mac(text)).toBeNull();
  });
  it("does not infer an event from unavailable OS queries or invalid boot IDs", () => {
    expect(mac(domain, "unknown")).toBeNull();
    expect(loginEventId({ platform: "darwin", uid: 501, run: () => { throw new Error("unavailable"); } })).toBeNull();
    expect(loginEventId({ platform: "win32", uid: 501 })).toBeNull();
  });
  it("uses the Linux logind graphical session and verifies its owner", () => {
    const run = (_command: string, args: string[]) => args[0] === "show-user" ? "c2" : "Id=c2\nUser=501\nType=wayland\nTimestampMonotonic=123456";
    expect(loginEventId({ platform: "linux", uid: 501, run, readFile: () => boot })).toBe(`linux:${boot}:501:c2:123456`);
    expect(loginEventId({ platform: "linux", uid: 502, run, readFile: () => boot })).toBeNull();
  });
});
