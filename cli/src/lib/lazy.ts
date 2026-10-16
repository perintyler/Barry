/** Keep command registration synchronous while loading an action on demand. */
export function lazy<M, A extends unknown[], R>(
  load: () => Promise<M>,
  pick: (module: M) => (...args: A) => R | Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args) => pick(await load())(...args);
}
