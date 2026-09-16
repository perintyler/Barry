import SwiftUI

/// Small uppercase tag — the 12%-tint pill used across the Barry apps.
///
/// Named `TagBadge`, not `Badge`, deliberately. `Sources/Views/InfoPanel.swift`
/// already declares a `private struct Badge` with a different API
/// (`Badge(text:style:)` over a `BadgeStyle` enum). Because that one is
/// file-private, moving an internal `Badge` into a shared target does **not**
/// produce a redeclaration error — it silently shadows inside that one file, so
/// `InfoPanel` would keep compiling against its own type while every other call
/// site resolved to this one. A distinct name keeps the two visibly separate.
public struct TagBadge: View {
    private let text: String
    private let color: Color

    public init(text: String, color: Color = .secondary) {
        self.text = text
        self.color = color
    }

    public var body: some View {
        Text(text)
            .font(AppFont.sans(size: 9, weight: .semibold))
            .tracking(0.4)
            .foregroundStyle(color)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 4))
    }
}

/// Dot-separated metadata, skipping empty parts so no stray "·" appears.
public struct MetaLine: View {
    private let parts: [Text]

    public init(parts: [Text]) {
        self.parts = parts
    }

    public var body: some View {
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

public extension Date {
    /// Compact relative age, e.g. "4m", "2h", "3d".
    var relativeAge: String {
        let seconds = Date().timeIntervalSince(self)
        if seconds < 60 { return "just now" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: self, relativeTo: Date())
    }
}
