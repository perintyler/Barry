import { afterEach, describe, expect, it, vi } from "vitest";
import { reportPermissions } from "./bag.js";

afterEach(() => vi.restoreAllMocks());

describe("bag doctor's macOS permissions", () => {
  it("reports each permission a bag declares, where to grant it and to which program", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));

    reportPermissions(
      [
        {
          name: "ableton",
          manifest: {
            permissions: [
              { kind: "automation", app: "System Events", reason: "presses keys in Live" },
              { kind: "accessibility", reason: "sends keystrokes" },
            ],
          },
        },
        { name: "quiet", manifest: null },
      ],
      "/opt/homebrew/bin/node",
    );

    const out = lines.join("\n");
    expect(out).toContain("grant each to /opt/homebrew/bin/node");
    expect(out).toContain("ableton: Automation → System Events — presses keys in Live");
    expect(out).toContain("ableton: Accessibility — sends keystrokes");
    expect(out).toContain("Privacy & Security › Automation");
    expect(out).not.toContain("quiet");
  });

  it("says nothing when no bag declares one", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    reportPermissions([{ name: "quiet", manifest: { permissions: [] } }], "/x/node");
    expect(log).not.toHaveBeenCalled();
  });
});
