/**
 * The sessions bag: its answer to `Barry`'s session questions (the `sessions`
 * subject a hosting process installs with `Barry.use`), what a process
 * holding only a session id asks of it, and how a session row reads as the
 * Session `Barry` hands out.
 */
export { sessions, selectionOf, sessionBound, resolveSessionBags, resolveSessionTools } from "./subject.js";
export { sessionOf, encodeSessionCursor, decodeSessionCursor } from "./domain.js";

