import Foundation

/// Pure rules for keeping a session's in-memory transcript bounded.
///
/// astra review F14: `MessagesState` had no retention policy at all — every
/// poll tick and every `loadOlder` page permanently grew `messages`, and
/// `buildSegments` re-walked the whole (unboundedly growing) array on every
/// mutation. A long-running session (hours of polling, or a deep scrollback)
/// accumulated messages and per-mutation CPU cost without bound.
///
/// This type owns only the trim decision — how many oldest messages to drop
/// once the list exceeds the cap, and what that does to `hasOlder` (dropping
/// real history means "there IS more above" becomes true again even if the
/// server had already said otherwise). It does not touch segment building;
/// `ConversationSegments.swift` has its own incremental patch functions, and
/// a trim is applied to `[Message]`/`[RenderedSegment]` in lockstep by the
/// caller (see `MessagesState.trimIfNeeded`).
public enum MessageRetention {
    /// How many messages to keep in memory at once. Sized generously against
    /// what a human actually scrolls through in one sitting — this is a
    /// memory/CPU bound for a long-idle session, not a UX limit; `loadOlder`
    /// still works past it, it just pages, the same as a fresh session does.
    public static let retainedMessageCap = 500

    /// How many messages to drop in one trim, once the cap is exceeded.
    /// Trimming in a batch (rather than one-at-a-time back down to the cap)
    /// means a session sitting exactly at the cap does not re-trim on every
    /// single new message.
    public static let trimBatchSize = 100

    /// Whether the message list should be trimmed right now.
    public static func shouldTrim(currentCount: Int) -> Bool {
        currentCount > retainedMessageCap
    }

    /// How many of the OLDEST messages to drop, given the current count.
    /// Never drops more than exist, and never drops so many that the list
    /// falls below the cap minus one batch (so a burst that arrives all at
    /// once doesn't over-trim past what's actually needed).
    public static func trimCount(currentCount: Int) -> Int {
        guard shouldTrim(currentCount: currentCount) else { return 0 }
        let target = max(retainedMessageCap - trimBatchSize, 0)
        return min(currentCount, currentCount - target)
    }
}
