import { BarryApiError } from "./errors.js";

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BarryApiError("Barry request was cancelled", { status: null, code: "cancelled" });
}

export async function* cursorPages<Page extends { nextCursor: string | null }>(
  fetchPage: (cursor: string | undefined) => Promise<Page>,
  initialCursor?: string,
  signal?: AbortSignal,
): AsyncGenerator<Page> {
  const seen = new Set<string>();
  let cursor = initialCursor;
  while (true) {
    assertNotCancelled(signal);
    if (cursor !== undefined) seen.add(cursor);
    const page = await fetchPage(cursor);
    assertNotCancelled(signal);
    // Capture before yielding: edits to a returned page cannot redirect traversal.
    const next = page.nextCursor;
    if (next !== null && (!next || seen.has(next))) {
      throw new BarryApiError("Barry pagination returned an empty or repeated cursor", { status: null, code: "invalid_pagination" });
    }
    yield page;
    if (next === null) return;
    cursor = next;
  }
}

export async function* pageItems<Page, Item>(
  pages: AsyncIterable<Page>,
  selectItems: (page: Page) => readonly Item[],
  signal?: AbortSignal,
): AsyncGenerator<Item> {
  for await (const page of pages) {
    for (const item of selectItems(page)) {
      assertNotCancelled(signal);
      yield item;
    }
  }
}
