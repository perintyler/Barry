import type { Session } from "./index.js";

/** Preserve private receivers and optional capabilities, including frozen third-party sessions. */
export function withRuntimeVersion(session: Session, runtimeVersion: NonNullable<Session["runtimeVersion"]>, notice?: string): Session {
  return {
    get id() { return session.id; },
    get harnessSessionId() { return session.harnessSessionId; },
    get harnessVersion() { return session.harnessVersion; },
    get mode() { return session.mode; },
    get guarantees() { return session.guarantees; },
    get warnings() { return notice ? [...session.warnings ?? [], notice] : session.warnings; },
    runtimeVersion,
    events: () => session.events(),
    deliver: (content, options) => session.deliver(content, options),
    interrupt: () => session.interrupt(),
    answer: (request, decision) => session.answer(request, decision),
    status: () => session.status(),
    close: () => session.close(),
    ...(session.warm ? { warm: () => session.warm!() } : {}),
    ...(session.touch ? { touch: () => session.touch!() } : {}),
    ...(session.isWarm ? { isWarm: () => session.isWarm!() } : {}),
    ...(session.compact ? { compact: () => session.compact!() } : {}),
    ...(session.attach ? { attach: () => session.attach!() } : {}),
    ...(session.detach ? { detach: () => session.detach!() } : {}),
    ...(session.externalTurns ? { externalTurns: () => session.externalTurns!() } : {}),
  };
}
