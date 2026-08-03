import Foundation

/// Conversation rendering model — pure transformation of `[Message]` into
/// displayable segments. Kept out of the view so it can be computed once per
/// data mutation (in `MessagesState`) and unit-tested in isolation.
///
/// Two segment kinds:
/// - `.turn` — consecutive text/error/system messages from the same speaker,
///   drawn with a tinted background and a "You"/"Barry" separator.
/// - `.toolRow` — a standalone `tool_start` message, flush-left, no background.
///   Tool rows live OUTSIDE turns, matching the v13 mock.

enum Speaker {
    case user, agent
}

struct Turn: Identifiable {
    let speaker: Speaker
    let messages: [Message]

    var id: Int { messages.first?.sequence ?? 0 }
    var firstTimestamp: String? { messages.first?.createdAt }
    var lastTimestamp: String? { messages.last?.createdAt }
}

enum SegmentKind {
    case turn(Turn)
    case toolRow(Message)

    var firstTimestamp: String? {
        switch self {
        case .turn(let t): return t.firstTimestamp
        case .toolRow(let m): return m.createdAt
        }
    }

    var lastTimestamp: String? {
        switch self {
        case .turn(let t): return t.lastTimestamp
        case .toolRow(let m): return m.createdAt
        }
    }

    var isTurn: Bool {
        if case .turn = self { return true }
        return false
    }
}

/// A conversation segment with spacing context and its timestamp pill baked in
/// during `buildSegments()`, so the ForEach body needs no index lookups.
///
/// `id` is the single identity used for BOTH `ForEach` and `ScrollPosition`
/// targeting — `"turn-N"` / `"tool-N"`. (Previously the view carried a parallel
/// `"msg-N"` id system for scrolling, which broke prepend anchoring.)
struct RenderedSegment: Identifiable {
    let segment: SegmentKind
    let id: String
    let timestampPill: String?
    let prevIsTurn: Bool
    let nextIsTurn: Bool
}

/// Build segments: text/error/system messages group into turns,
/// `tool_start` messages become standalone rows outside turns.
/// Returns `RenderedSegment`s with spacing and timestamp context pre-computed.
func buildSegments(_ messages: [Message]) -> [RenderedSegment] {
    var kinds: [SegmentKind] = []
    var turnBuffer: [Message] = []
    var currentSpeaker: Speaker?

    func flushTurn() {
        if !turnBuffer.isEmpty, let s = currentSpeaker {
            kinds.append(.turn(Turn(speaker: s, messages: turnBuffer)))
            turnBuffer = []
            currentSpeaker = nil
        }
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

    return kinds.enumerated().map { idx, kind in
        let segId: String
        switch kind {
        case .turn(let t): segId = "turn-\(t.id)"
        case .toolRow(let m): segId = "tool-\(m.sequence)"
        }

        let pill = timestampPillText(kinds: kinds, at: idx)
        let prev = idx > 0 && kinds[idx - 1].isTurn
        let next = idx < kinds.count - 1 && kinds[idx + 1].isTurn

        return RenderedSegment(
            segment: kind,
            id: segId,
            timestampPill: pill,
            prevIsTurn: prev,
            nextIsTurn: next
        )
    }
}

/// The segment id (`"turn-N"` / `"tool-N"`) whose segment contains `sequence`.
/// Used to resolve a deep-link `scrollToSequence` to a scroll target.
func segmentId(containing sequence: Int, in segments: [RenderedSegment]) -> String? {
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

/// Formatted timestamp if there's a >5 min gap before this segment, or for the
/// first segment; otherwise nil (no pill).
func timestampPillText(kinds: [SegmentKind], at index: Int) -> String? {
    guard index > 0 else {
        if let ts = kinds.first?.firstTimestamp {
            return formatTimestamp(ts)
        }
        return nil
    }
    guard let prevTime = kinds[index - 1].lastTimestamp,
          let currTime = kinds[index].firstTimestamp,
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
