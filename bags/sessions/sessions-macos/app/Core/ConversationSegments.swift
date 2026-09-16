import Foundation

/// Conversation rendering model — pure transformation of `[Message]` into
/// displayable segments. Lives in `BarrySessionsCore` (not the app target) so
/// it can be unit-tested directly and so mutation cost can be pinned with
/// fixtures far larger than the "does it look right" tests need — the F14
/// astra review finding was exactly this: `buildSegments(messages)` re-walked
/// the ENTIRE transcript from `Message` 1 on every append, poll tick, and
/// detail-load, so a long-running session's per-message cost grew without
/// bound. `appendSegments`/`prependSegments` below patch only the boundary.
///
/// Two segment kinds:
/// - `.turn` — consecutive text/error/system messages from the same speaker,
///   drawn with a tinted background and a "You"/"Barry" separator.
/// - `.toolRow` — a standalone `tool_start` message, flush-left, no background.
///   Tool rows live OUTSIDE turns, matching the v13 mock.

public enum Speaker {
    case user, agent
}

public struct Turn: Identifiable {
    public let speaker: Speaker
    public let messages: [Message]

    public var id: Int { messages.first?.sequence ?? 0 }
    public var firstTimestamp: String? { messages.first?.createdAt }
    public var lastTimestamp: String? { messages.last?.createdAt }
}

public enum SegmentKind {
    case turn(Turn)
    case toolRow(Message)

    public var firstTimestamp: String? {
        switch self {
        case .turn(let t): return t.firstTimestamp
        case .toolRow(let m): return m.createdAt
        }
    }

    public var lastTimestamp: String? {
        switch self {
        case .turn(let t): return t.lastTimestamp
        case .toolRow(let m): return m.createdAt
        }
    }

    public var isTurn: Bool {
        if case .turn = self { return true }
        return false
    }

    fileprivate var speaker: Speaker? {
        if case .turn(let t) = self { return t.speaker }
        return nil
    }
}

/// A conversation segment with spacing context and its timestamp pill baked in
/// during `buildSegments()`/`appendSegments()`/`prependSegments()`, so the
/// ForEach body needs no index lookups.
///
/// `id` is the single identity used for BOTH `ForEach` and `ScrollPosition`
/// targeting — `"turn-N"` / `"tool-N"`. (Previously the view carried a parallel
/// `"msg-N"` id system for scrolling, which broke prepend anchoring.)
public struct RenderedSegment: Identifiable {
    public let segment: SegmentKind
    public let id: String
    public let timestampPill: String?
    public let prevIsTurn: Bool
    public let nextIsTurn: Bool
}

// MARK: - Grouping (shared by full build and incremental patch)

/// Counts messages actually walked by `groupIntoKinds`, so a test can assert
/// an append/prepend touched only the boundary rather than the whole
/// transcript — the thing "O(newMessages.count), not O(existing.count)" above
/// actually means, made checkable without a timing-based test.
///
/// `public`, not test-gated: `Tests/` (`BarrySessionsTests`) consumes
/// `BarrySessionsCore` as a regular dependency, not via `@testable import`
/// (see `SessionPagingTests.swift` — it uses `@testable` for a different
/// reason, unrelated internal symbols), so this has to be visible the normal
/// way. A `#if DEBUG` counter would also work but would make the metric
/// silently vanish from a release build with no compile-time signal.
public enum MessageGroupingMetrics {
    public private(set) static var messagesGrouped = 0

    public static func reset() { messagesGrouped = 0 }

    /// `private(set)`'s scope is this enum, not the file — `groupIntoKinds`
    /// below is a free function in the same file but a different scope, so it
    /// needs this instead of assigning the property directly.
    fileprivate static func recordGrouped(_ count: Int) { messagesGrouped += count }
}

/// Group a run of messages into turns/tool-rows. `seedSpeaker` is the speaker
/// of a turn already in progress that this run may continue (used when
/// patching onto an existing last-turn); pass `nil` for a fresh group (full
/// build, or a prepend that starts its own independent run).
///
/// Returns the grouped kinds AND the leftover open turn's speaker, if the run
/// ended mid-turn — callers that are about to append more (there are none
/// today, but this keeps the seam honest) would seed the next call with it.
private func groupIntoKinds(_ messages: [Message], seedSpeaker: Speaker?) -> [SegmentKind] {
    MessageGroupingMetrics.recordGrouped(messages.count)
    var kinds: [SegmentKind] = []
    var turnBuffer: [Message] = []
    var currentSpeaker: Speaker? = seedSpeaker

    func flushTurn() {
        if !turnBuffer.isEmpty, let s = currentSpeaker {
            kinds.append(.turn(Turn(speaker: s, messages: turnBuffer)))
            turnBuffer = []
        }
        currentSpeaker = nil
    }

    for msg in messages {
        if msg.type == "tool_start" {
            flushTurn()
            kinds.append(.toolRow(msg))
        } else {
            let speaker: Speaker = msg.isUser ? .user : .agent
            if speaker != currentSpeaker {
                flushTurn()
                currentSpeaker = speaker
            }
            turnBuffer.append(msg)
        }
    }
    flushTurn()

    return kinds
}

/// Re-derive `RenderedSegment`s for a contiguous run of `kinds`, given the
/// segment immediately before the run (for pill continuity) and whether a
/// segment follows. `startIndexInFullList`/`totalCount` place `idx` correctly
/// for `prevIsTurn`/`nextIsTurn` against neighbors outside the run.
private func renderKinds(
    _ kinds: [SegmentKind],
    precededBy previous: SegmentKind?,
    followedBy next: SegmentKind?
) -> [RenderedSegment] {
    kinds.enumerated().map { idx, kind in
        let segId: String
        switch kind {
        case .turn(let t): segId = "turn-\(t.id)"
        case .toolRow(let m): segId = "tool-\(m.sequence)"
        }

        let prevKind = idx > 0 ? kinds[idx - 1] : previous
        let nextKind = idx < kinds.count - 1 ? kinds[idx + 1] : next

        let pill: String?
        if let prevKind {
            pill = timestampPillText(previous: prevKind, current: kind)
        } else {
            // First segment in the whole conversation.
            pill = kind.firstTimestamp.map(formatTimestamp)
        }

        return RenderedSegment(
            segment: kind,
            id: segId,
            timestampPill: pill,
            prevIsTurn: prevKind?.isTurn ?? false,
            nextIsTurn: nextKind?.isTurn ?? false
        )
    }
}

/// Build segments from scratch: text/error/system messages group into turns,
/// `tool_start` messages become standalone rows outside turns.
/// Returns `RenderedSegment`s with spacing and timestamp context pre-computed.
///
/// O(n) in the full message count — use `appendSegments`/`prependSegments`
/// for an incremental update instead of calling this again on every mutation.
public func buildSegments(_ messages: [Message]) -> [RenderedSegment] {
    let kinds = groupIntoKinds(messages, seedSpeaker: nil)
    return renderKinds(kinds, precededBy: nil, followedBy: nil)
}

// MARK: - Incremental patching

/// Append newly-arrived messages onto an existing, already-built segment list.
///
/// Only the boundary is re-derived: if the last existing segment is a turn
/// and the new messages start with the same speaker, they extend that turn
/// (its `RenderedSegment` is replaced) rather than starting a redundant one.
/// Everything before the last existing segment is untouched — reused by
/// reference, not recomputed — so cost is O(newMessages.count), not
/// O(existing.count + newMessages.count).
///
/// `newMessages` must be in the same order `buildSegments` would see them
/// (oldest of the batch first) and must sort after every message already
/// folded into `existing`.
public func appendSegments(
    to existing: [RenderedSegment],
    appending newMessages: [Message]
) -> [RenderedSegment] {
    guard !newMessages.isEmpty else { return existing }
    guard let lastExisting = existing.last else {
        return buildSegments(newMessages)
    }

    // Does the new run continue the last existing turn, or start fresh?
    let seed = lastExisting.segment.speaker
    var newKinds = groupIntoKinds(newMessages, seedSpeaker: seed)
    guard !newKinds.isEmpty else { return existing }

    let continuesLastTurn: Bool
    if let seed, case .turn(let firstNewTurn) = newKinds[0], firstNewTurn.speaker == seed {
        continuesLastTurn = true
    } else {
        continuesLastTurn = false
    }

    let untouchedPrefix: [RenderedSegment]
    let precedingKind: SegmentKind?
    if continuesLastTurn {
        // The last existing RenderedSegment is being replaced by the merged
        // turn (first new kind absorbs it) — drop it from the untouched
        // prefix and merge its messages into newKinds[0].
        untouchedPrefix = Array(existing.dropLast())
        precedingKind = untouchedPrefix.last?.segment
        if case .turn(let oldTurn) = lastExisting.segment, case .turn(let newTurn) = newKinds[0] {
            newKinds[0] = .turn(Turn(speaker: newTurn.speaker, messages: oldTurn.messages + newTurn.messages))
        }
    } else {
        untouchedPrefix = existing
        precedingKind = lastExisting.segment
    }

    let patched = renderKinds(newKinds, precededBy: precedingKind, followedBy: nil)

    // The segment right before the patched run may have had `nextIsTurn`
    // computed against the OLD boundary (nothing, or a different kind) — fix
    // it up now that something new follows. Its pill is unaffected (pills
    // depend on the PREVIOUS segment, not the next one).
    var prefix = untouchedPrefix
    if !prefix.isEmpty, let firstPatched = patched.first {
        let last = prefix[prefix.count - 1]
        prefix[prefix.count - 1] = RenderedSegment(
            segment: last.segment,
            id: last.id,
            timestampPill: last.timestampPill,
            prevIsTurn: last.prevIsTurn,
            nextIsTurn: firstPatched.segment.isTurn
        )
    }

    return prefix + patched
}

/// Prepend older messages (a `loadOlder` page) onto an existing segment list.
///
/// Symmetric to `appendSegments`: if the new run's last kind is a turn with
/// the same speaker as the existing list's first segment, they merge. Only
/// the merged/new boundary segments are re-derived — the rest of `existing`
/// is reused by reference.
///
/// `olderMessages` must be oldest-first (the order `loadOlder`'s response,
/// once deduped, is already in) and must sort entirely before every message
/// already folded into `existing`.
public func prependSegments(
    to existing: [RenderedSegment],
    prepending olderMessages: [Message]
) -> [RenderedSegment] {
    guard !olderMessages.isEmpty else { return existing }
    guard let firstExisting = existing.first else {
        return buildSegments(olderMessages)
    }

    var newKinds = groupIntoKinds(olderMessages, seedSpeaker: nil)
    guard !newKinds.isEmpty else { return existing }

    let mergesIntoFirst: Bool
    if case .turn(let lastNewTurn) = newKinds[newKinds.count - 1],
       case .turn(let firstOldTurn) = firstExisting.segment,
       lastNewTurn.speaker == firstOldTurn.speaker {
        mergesIntoFirst = true
    } else {
        mergesIntoFirst = false
    }

    let untouchedSuffix: [RenderedSegment]
    let followingKind: SegmentKind?
    if mergesIntoFirst {
        untouchedSuffix = Array(existing.dropFirst())
        followingKind = untouchedSuffix.first?.segment
        if case .turn(let lastNewTurn) = newKinds[newKinds.count - 1],
           case .turn(let firstOldTurn) = firstExisting.segment {
            newKinds[newKinds.count - 1] = .turn(
                Turn(speaker: lastNewTurn.speaker, messages: lastNewTurn.messages + firstOldTurn.messages)
            )
        }
    } else {
        untouchedSuffix = existing
        followingKind = firstExisting.segment
    }

    let patched = renderKinds(newKinds, precededBy: nil, followedBy: followingKind)

    // The segment right after the patched run may have had its pill computed
    // against the OLD (nonexistent, or different) predecessor — recompute
    // just that one. Its own `prevIsTurn`/`nextIsTurn` for anything further
    // along is untouched.
    var suffix = untouchedSuffix
    if !suffix.isEmpty, let lastPatched = patched.last {
        let first = suffix[0]
        let pill: String?
        if mergesIntoFirst {
            // first's messages were absorbed into patched.last — recompute
            // from the new predecessor.
            pill = timestampPillText(previous: lastPatched.segment, current: first.segment)
        } else {
            pill = timestampPillText(previous: lastPatched.segment, current: first.segment)
        }
        suffix[0] = RenderedSegment(
            segment: first.segment,
            id: first.id,
            timestampPill: pill,
            prevIsTurn: lastPatched.segment.isTurn,
            nextIsTurn: first.nextIsTurn
        )
    }

    return patched + suffix
}

/// The segment id (`"turn-N"` / `"tool-N"`) whose segment contains `sequence`.
/// Used to resolve a deep-link `scrollToSequence` to a scroll target.
public func segmentId(containing sequence: Int, in segments: [RenderedSegment]) -> String? {
    for rendered in segments {
        switch rendered.segment {
        case .toolRow(let msg) where msg.sequence == sequence:
            return rendered.id
        case .turn(let turn):
            if turn.messages.contains(where: { $0.sequence == sequence }) {
                return rendered.id
            }
        default:
            continue
        }
    }
    return nil
}

// MARK: - Timestamp pills

/// Formatted timestamp if there's a >5 min gap between `previous` and
/// `current`, or if `previous` is nil (first segment); otherwise nil (no pill).
func timestampPillText(previous: SegmentKind?, current: SegmentKind) -> String? {
    guard let previous else {
        return current.firstTimestamp.map(formatTimestamp)
    }
    guard let prevTime = previous.lastTimestamp,
          let currTime = current.firstTimestamp,
          let prevDate = parseISO(prevTime),
          let currDate = parseISO(currTime),
          currDate.timeIntervalSince(prevDate) > 300 else {
        return nil
    }
    return formatTimestamp(currTime)
}

// Static formatters — creating these is expensive, reuse across calls.
private let isoFormatterFractional: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

private let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()

// One formatter per date-format pattern — avoids mutating a shared DateFormatter
// (DateFormatter is not thread-safe; changing dateFormat on a shared instance
// caused intermittent stutters when buildSegments ran during a scroll callback).
private let todayFormatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "'Today,' h:mm a"
    return f
}()
private let yesterdayFormatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "'Yesterday,' h:mm a"
    return f
}()
private let defaultFormatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "MMM d, h:mm a"
    return f
}()

func parseISO(_ iso: String) -> Date? {
    isoFormatterFractional.date(from: iso) ?? isoFormatter.date(from: iso)
}

func formatTimestamp(_ iso: String) -> String {
    guard let date = parseISO(iso) else { return iso }
    if Calendar.current.isDateInToday(date) {
        return todayFormatter.string(from: date)
    } else if Calendar.current.isDateInYesterday(date) {
        return yesterdayFormatter.string(from: date)
    } else {
        return defaultFormatter.string(from: date)
    }
}
