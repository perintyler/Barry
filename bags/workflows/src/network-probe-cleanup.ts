import type { ChildProcess } from "node:child_process";

export interface ProbeChildExit {
  role: string;
  pid: number | null;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  forcedKill: boolean;
  exited: boolean;
}

export function probeChildrenExitedCleanly(exits: ProbeChildExit[]): boolean {
  return exits.length === 2 && new Set(exits.map(exit => exit.role)).size === 2 && new Set(exits.map(exit => exit.pid)).size === 2 && exits.some(exit => exit.role === "owner") && exits.some(exit => exit.role === "worker") && exits.every(exit => exit.pid !== null && Number.isInteger(exit.pid) && exit.pid > 0 && exit.exited && exit.exitCode === 0 && exit.signalCode === null && !exit.forcedKill);
}

/** Never wait again for an exit event that already happened, including signals. */
export function stopProbeChild(child: ChildProcess, role: string, graceMs = 10_000, killWaitMs = 2000): Promise<ProbeChildExit> {
  let forcedKill = false;
  const snapshot = (): ProbeChildExit => ({ role, pid: child.pid ?? null, exitCode: child.exitCode, signalCode: child.signalCode, forcedKill, exited: child.exitCode !== null || child.signalCode !== null });
  if (snapshot().exited) return Promise.resolve(snapshot());
  return new Promise(resolve => {
    let finalTimer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(forceTimer); clearTimeout(finalTimer);
      child.off("exit", finish);
      resolve(snapshot());
    };
    child.once("exit", finish);
    const forceTimer = setTimeout(() => {
      forcedKill = true; child.kill("SIGKILL");
      // Even a failed kill or missing event must yield a failed bounded receipt.
      finalTimer = setTimeout(finish, killWaitMs);
    }, graceMs);
    child.kill("SIGTERM");
    if (snapshot().exited) finish();
  });
}
