import SwiftUI

/// Small uppercase tag — the 12%-tint pill used across the Barry apps.
struct Badge: View {
    let text: String
    var color: Color = .secondary

    var body: some View {
        Text(text)
            .font(AppFont.sans(size: 9, weight: .semibold))
            .tracking(0.4)
            .foregroundStyle(color)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 4))
    }
}

/// Severity indicator. Unread events get a filled dot, read events a ring, so
/// read state survives even where the row background is subtle.
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

/// Dot-separated metadata, skipping empty parts so no stray "·" appears.
struct MetaLine: View {
    let parts: [Text]

    var body: some View {
        HStack(spacing: 5) {
            ForEach(Array(parts.enumerated()), id: \.offset) { index, part in
                if index > 0 {
                    Text("·").font(AppFont.sans(size: 10)).foregroundStyle(.quaternary)
                }
                part
            }
        }
    }
}

extension Date {
    /// Compact relative age, e.g. "4m", "2h", "3d".
    var relativeAge: String {
        let seconds = Date().timeIntervalSince(self)
        if seconds < 60 { return "just now" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: self, relativeTo: Date())
    }
}
