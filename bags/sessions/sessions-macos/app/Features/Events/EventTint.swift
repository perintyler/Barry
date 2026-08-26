import Components
import SwiftUI

// The generic pieces that used to live here — `Color.adaptive` and the Tailwind
// `Palette` — moved into the `Components` target, which every feature imports.
// What stays is the part that only means something to events: which severity is
// red, which type gets which glyph. Keeping the mapping next to the types it
// switches over means adding an `EventType` case fails to compile here rather
// than silently falling through to a default color in a shared file.

extension Severity {
    var color: Color {
        switch self {
        case .success: return Palette.green
        case .error: return Palette.red
        case .warn: return Palette.amber
        case .info: return Palette.blue
        }
    }
}

extension EventType {
    /// Tint for the type badge — deliberately distinct from severity, which
    /// owns the dot, so the two signals don't collapse into one.
    var tint: Color {
        switch self {
        case .progress: return Palette.blue
        case .taskFinished: return Palette.green
        case .systemAlert: return Palette.amber
        case .notification, .other: return .secondary
        }
    }

    var symbol: String {
        switch self {
        case .progress: return "circle.dashed"
        case .notification: return "bell"
        case .taskFinished: return "checkmark.circle"
        case .systemAlert: return "exclamationmark.triangle"
        case .other: return "circle"
        }
    }
}

/// Colors for the agent phase carried on progress events.
func phaseColor(_ phase: String) -> Color {
    switch phase {
    case "complete": return Palette.green
    case "blocked": return Palette.red
    case "building", "reviewing", "planning": return Palette.blue
    default: return .secondary
    }
}

/// Severity indicator. Unread events get a filled dot, read events a ring, so
/// read state survives even where the row background is subtle.
///
/// Stays in this target rather than `Components` because it is keyed by
/// `Severity`, which is an events concept.
struct SeverityDot: View {
    let severity: Severity
    let isUnread: Bool

    var body: some View {
        Group {
            if isUnread {
                Circle().fill(severity.color)
            } else {
                Circle().strokeBorder(severity.color.opacity(0.45), lineWidth: 1.5)
            }
        }
        .frame(width: 7, height: 7)
    }
}
