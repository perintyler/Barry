/**
 * Pass a deliberately wrong type to a function, to test the runtime guard that
 * defends against callers who ignore the signature — untyped JS, JSON off the
 * wire, an `any`-typed boundary upstream.
 *
 * The wrong type is the point of such a test, so the cast is the assertion
 * rather than a workaround. Routing them through here keeps the intent legible
 * and keeps the escape hatch countable.
 */
export function invalidInput<T>(value: unknown): T {
  return value as T;
}
