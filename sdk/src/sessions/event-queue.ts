/**
 * Events pushed by a session and pulled by its reader, each delivered once.
 *
 * Buffers while nobody is reading, because a reader typically starts reading
 * just after delivering a message — and the harness may already have answered.
 */
export class EventQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private readonly waiting: Array<(next: IteratorResult<T, undefined>) => void> = [];
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    const reader = this.waiting.shift();
    if (reader) reader({ value: item, done: false });
    else this.buffered.push(item);
  }

  /** Readers drain what is buffered, then stop. */
  end(): void {
    this.ended = true;
    for (const reader of this.waiting.splice(0)) reader({ value: undefined, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.buffered.length > 0) {
        yield this.buffered.shift() as T;
        continue;
      }
      if (this.ended) return;
      const next = await new Promise<IteratorResult<T, undefined>>((resolve) => this.waiting.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}
