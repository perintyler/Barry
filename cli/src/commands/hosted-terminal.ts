/**
 * `barry start --mode hosted`: the terminal as one renderer of a session Barry
 * hosts.
 *
 * The session runs in Barry's API — the runtime the web and the phone reach —
 * so it outlives this terminal, and a message sent from elsewhere shows up
 * here as it runs. This module only renders: each line typed is a turn, the
 * session's updates are printed as they arrive, and an interrupt ends the
 * running turn rather than the session.
 *
 * The same loop runs a one-shot (`-p`): one turn, then done.
 */

/** One update the API broadcasts about a session, as far as a terminal reads it. */
export interface SessionUpdate {
  type: string;
  content?: string;
  role?: string;
  name?: string;
  result?: string;
  error?: string;
  status?: string;
  metadata?: { timing?: Record<string, number>; code?: string };
}

export interface HostedSessionApi {
  /**
   * Hand the session a message. The first one also starts the session on its
   * harness. Resolves to a reason when the API refused it, null when taken.
   */
  send(content: string, first: boolean): Promise<string | null>;
  interrupt(): Promise<void | {message?:string}>;
  stop?(): Promise<void>;
}

export interface HostedTerminalIO {
  /** The next line typed, or null once the user is done. */
  read(): Promise<string | null>;
  write(text: string): void;
}

export interface HostedTerminal {
  /** Runs until the user is done (or the one turn has ended). The exit code. */
  done: Promise<number>;
  /**
   * What Ctrl-C means now: end the running turn when there is one (true),
   * or nothing to interrupt — the caller leaves (false).
   */
  interrupt(): Promise<boolean>;
}

/** How long a tool's output is shown before it is cut: the session keeps all of it. */
const TOOL_PREVIEW_CHARS = 200;

export function runHostedTerminal(
  io: HostedTerminalIO,
  api: HostedSessionApi,
  updates: AsyncIterable<SessionUpdate>,
  options: { prompt?: string; once?: boolean } = {},
): HostedTerminal {
  /** Set while a turn this terminal sent is running: how its end is told. */
  const running: { end: (() => void) | null } = { end: null };
  let answerShown = false;
  const stream={bytes:0,thinking:"",thinkingVisible:false};
  let turnNumber=0;
  let interruptRequested=false;
  let stopped=false;
  let stopPending:Promise<void>|null=null;
  let finishStop!:(code:number)=>void;
  const stopDone=new Promise<number>(resolve=>{finishStop=resolve;});
  /** What this terminal sent, so the API's echo of it is not printed again as someone else's. */
  const sentHere: string[] = [];
  let failed = false;

  void (async () => {
    for await (const update of updates) {
      const shown = render(update, { answerShown, sentHere, stream });
      if (shown) io.write(shown);
      if (update.type === "text" && update.role !== "user" && update.content) answerShown = true;
      if (update.type === "error" || (update.type === "result" && update.error)) failed = true;
      const end = running.end;
      if (isTurnEnd(update) && end) {
        running.end = null;
        interruptRequested=false;
        end();
      }
    }
  })();

  const turn = async (content: string, first: boolean): Promise<void> => {
    turnNumber++;
    answerShown = false; stream.bytes=0;stream.thinking="";stream.thinkingVisible=false;interruptRequested=false;
    const ended = new Promise<void>((resolve) => (running.end = resolve));
    sentHere.push(content);
    const refused = await api.send(content, first);
    if (refused) {
      running.end = null;
      failed = true;
      io.write(`Barry did not take that message: ${refused}\n`);
      return;
    }
    await ended;
  };

  const done = (async () => {
    let first = true;
    if (options.prompt) {
      await turn(options.prompt, first);
      first = false;
      if (options.once) return failed ? 1 : 0;
    }
    for (;;) {
      const line = await io.read();
      if (line === null) return 0;
      if (!line.trim()) continue;
      await turn(line, first);
      first = false;
    }
  })();

  return {
    done:Promise.race([done.then(async code=>{
      // The terminal waiting frame can beat the stop HTTP response. Keep
      // ownership of the exit code until that explicit stop settles.
      const pending=stopPending;
      if(pending){try{await pending;return 130;}catch{/* Reported by interrupt(). */}}
      return stopped?130:code;
    }),stopDone]),
    interrupt: async () => {
      if (!running.end) return false;
      if(interruptRequested) {
        if(!stopped){stopped=true;stopPending=Promise.resolve().then(()=>api.stop?.());try{await stopPending;finishStop(130);}catch(error){stopped=false;throw error;}finally{stopPending=null;}}
        return true;
      }
      interruptRequested=true;
      const number=turnNumber;
      const response=await api.interrupt();
      if(!stopped && number===turnNumber)io.write(`${response?.message??"Turn interrupted"} (Ctrl-C again to stop)\n`);
      return true;
    },
  };
}

function isTurnEnd(update: SessionUpdate): boolean {
  return update.type === "result" || (update.type === "status" && ["waiting", "complete", "error"].includes(update.status ?? ""));
}

/** One update as the terminal shows it, or null for what it does not. */
function render(update: SessionUpdate, state: { answerShown: boolean; sentHere: string[]; stream: {bytes:number;thinking:string;thinkingVisible:boolean} }): string | null {
  switch (update.type) {
    case "partial": {const prefix=state.stream.thinkingVisible?"\n":"";state.stream.thinkingVisible=false;state.stream.bytes+=update.content?.length??0;return prefix+(update.content??"");}
    case "thinking": {
      if(!update.content)return null;
      state.stream.thinking+=update.content;state.stream.thinkingVisible=true;
      const width=Math.max(1,(process.stdout.columns??80)-3);
      const tail=Array.from(state.stream.thinking.replace(/\s+/g," ")).slice(-width).join("");
      return `\r\x1b[2K\x1b[2m∴ ${tail}\x1b[0m`;
    }
    case "status": if (update.metadata?.code==="persistence_lagging") return "\nrecording delayed…\n"; if (update.metadata?.code==="persistence_recovered") return "\nrecording caught up\n"; return update.status==="starting" ? "[2mstarting…[0m\n" : null;
    case "text": {
      if (!update.content) return null;
      if (update.role === "user") {
        // Its own message comes back from the API; one from the web or phone is news.
        const own = state.sentHere.indexOf(update.content);
        if (own >= 0) {
          state.sentHere.splice(own, 1);
          return null;
        }
        return `\n› (from elsewhere) ${update.content}\n`;
      }
      if (state.stream.bytes) {state.stream.bytes=0;return "\n";}
      return `${update.content}\n`;
    }
    case "tool_start": {
      const prefix=state.stream.thinkingVisible?"\n":"";state.stream.thinkingVisible=false;
      return update.name ? `${prefix}⚡ ${update.name}\n` : null;
    }
    case "tool_result": {
      if (!update.result) return null;
      const preview = update.result.length > TOOL_PREVIEW_CHARS ? `${update.result.slice(0, TOOL_PREVIEW_CHARS)}...` : update.result;
      return `  → ${preview}\n`;
    }
    case "error":
      return `Error: ${update.error ?? "unknown"}\n`;
    case "result":
      // The answer arrives as text and again as the result; it is shown once.
      if (update.error) return `Session error: ${update.error}\n`;
      return update.result && !state.answerShown ? `${update.result}\n` : null;
    default:
      return null;
  }
}
