/**
 * A TUI on a terminal the test owns, as a person would run it.
 *
 * Python's `pty` rather than a Node package: it needs no native build. The
 * relay answers the queries a TUI sends its terminal (cursor position, device
 * attributes, colours), because claude waits for those answers before drawing.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const RELAY = String.raw`
import os, pty, select, signal, struct, sys, fcntl, termios
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 140, 0, 0))
signal.signal(signal.SIGTERM, lambda *_: (os.kill(pid, signal.SIGKILL), sys.exit(0)))
answers = {b"\x1b[6n": b"\x1b[1;1R", b"\x1b[c": b"\x1b[?62;22c", b"\x1b[0c": b"\x1b[?62;22c", b"\x1b[?u": b"\x1b[?0u", b"\x1b]10;?": b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\", b"\x1b]11;?": b"\x1b]11;rgb:0000/0000/0000\x1b\\"}
while True:
    ready, _, _ = select.select([fd, 0], [], [])
    if fd in ready:
        try:
            out = os.read(fd, 65536)
        except OSError:
            break
        if not out:
            break
        for query, answer in answers.items():
            if query in out:
                os.write(fd, answer)
        os.write(1, out)
    if 0 in ready:
        typed = os.read(0, 65536)
        if typed:
            os.write(fd, typed)
`;

// eslint-disable-next-line no-control-regex -- matches the terminal escape sequences a TUI draws with
const ESCAPES = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78]/g;

export interface Terminal {
  /** Everything the TUI has drawn so far, without escape sequences. */
  screen(): string;
  /** Types text, then Enter as a separate keystroke, which TUIs need to see a submit. */
  submit(text: string): Promise<void>;
  press(keys: string): void;
  close(): Promise<void>;
}

export function runOnTerminal(command: string, args: string[], options: { env: Record<string, string | undefined>; cwd?: string }): Terminal {
  const relay: ChildProcess = spawn("python3", ["-c", RELAY, command, ...args], {
    env: options.env,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    stdio: ["pipe", "pipe", "ignore"],
  });
  let drawn = "";
  relay.stdout?.on("data", (chunk: Buffer) => (drawn += chunk.toString()));
  return {
    screen: () => drawn.replace(ESCAPES, " ").replace(/[ \t]+/g, " "),
    async submit(text) {
      relay.stdin?.write(text);
      await sleep(500);
      relay.stdin?.write("\r");
    },
    press: (keys) => void relay.stdin?.write(keys),
    async close() {
      if (relay.exitCode !== null) return;
      relay.kill("SIGTERM");
      await Promise.race([once(relay, "exit"), sleep(5_000)]);
    },
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function until(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}
