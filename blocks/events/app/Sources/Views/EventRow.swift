import SwiftUI

/// One event in the feed.
///
/// Barry events arrive in two very different shapes: agent-written progress
/// events run to several hundred characters, while notifications are a short
/// headline. A fixed clamp mangles the former and a full expansion buries the
/// latter — so the row previews at three lines and expands in place on click.
struct EventRow: View {
    let event: BarryEvent
    let isExpanded: Bool
    let onToggle: () -> Void
    let onOpenSession: () -> Void
    let onMarkRead: () -> Void

    @State private var isHovering = false

    private var accentColor: Color { event.severity.color }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                SeverityDot(severity: event.severity, isUnread: event.isUnread)
                    .padding(.top, 4)

                // The full text is always laid out; collapsing clips it to three
                // lines' worth of height rather than changing `lineLimit`.
                // Re-measuring text can't interpolate, so animating a line count
                // reads as a jump — animating a height reads as a reveal.
                Text(event.displayTitle)
                    .font(AppFont.sans(size: 12, weight: event.isUnread ? .medium : .regular))
                    .foregroundStyle(event.isUnread ? .primary : .secondary)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .modifier(CollapsibleText(isExpanded: isExpanded, collapsedLines: 3))

                Spacer(minLength: 0)
            }

            metadata
                .padding(.leading, 15)

            if isExpanded {
                expandedDetail
                    .padding(.leading, 15)
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(rowBackground)
        // Unread marker — a hairline rather than a full-bleed tint, so a screen
        // of unread events stays calm.
        .overlay(alignment: .leading) {
            if event.isUnread {
                Rectangle()
                    .fill(accentColor.opacity(0.85))
                    .frame(width: 2)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture(perform: onToggle)
        .onHover { hovering in
            // Cross-fade the hover wash; an instant swap flickers when the
            // pointer crosses rows quickly.
            withAnimation(.easeOut(duration: 0.12)) { isHovering = hovering }
        }
    }

    @ViewBuilder
    private var rowBackground: some View {
        if isExpanded {
            Palette.expandedBackground
        } else if isHovering {
            Palette.hover
        } else {
            Color.clear
        }
    }

    private var metadata: some View {
        MetaLine(parts: metaParts)
    }

    private var metaParts: [Text] {
        var parts: [Text] = [
            Text(event.type.label)
                .font(AppFont.sans(size: 9, weight: .semibold))
                .foregroundColor(event.type.tint)
        ]
        if let phase = event.phase {
            parts.append(
                Text(phase)
                    .font(AppFont.sans(size: 10))
                    .foregroundColor(phaseColor(phase))
            )
        }
        parts.append(
            Text(event.source)
                .font(AppFont.mono(size: 10))
                .foregroundColor(.secondary)
        )
        parts.append(
            Text(event.createdAt.relativeAge)
                .font(AppFont.sans(size: 10))
                .foregroundColor(.secondary)
        )
        return parts
    }

    private var expandedDetail: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let body = event.body, !body.isEmpty {
                Text(body)
                    .font(AppFont.sans(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if !event.detailPairs.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(event.detailPairs, id: \.key) { pair in
                        HStack(alignment: .top, spacing: 6) {
                            Text(pair.key)
                                .font(AppFont.mono(size: 10))
                                .foregroundStyle(.tertiary)
                            Text(pair.value)
                                .font(AppFont.mono(size: 10))
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Palette.hover, in: RoundedRectangle(cornerRadius: 6))
            }

            HStack(spacing: 6) {
                if event.sessionId != nil {
                    ActionButton(title: "Open session", symbol: "arrow.up.forward.square", action: onOpenSession)
                }
                if event.isUnread {
                    ActionButton(title: "Mark read", symbol: "checkmark", action: onMarkRead)
                }
            }
            .padding(.top, 2)
        }
    }
}

/// Clips a fully-laid-out text block to N lines' worth of height, so expanding
/// animates a height the system can interpolate instead of a line count it
/// cannot. Until the first measurement lands nothing is clipped, so text is
/// never hidden by a missing measurement.
private struct CollapsibleText: ViewModifier {
    let isExpanded: Bool
    let collapsedLines: Int

    @State private var fullHeight: CGFloat = 0
    @State private var lineHeight: CGFloat = 0

    /// Only clip when the text actually overflows — otherwise short rows would
    /// animate toward a ceiling they never reach.
    private var targetHeight: CGFloat? {
        guard !isExpanded, fullHeight > 0, lineHeight > 0 else { return nil }
        let collapsed = lineHeight * CGFloat(collapsedLines)
        return fullHeight > collapsed ? collapsed : nil
    }

    func body(content: Content) -> some View {
        content
            .background(
                GeometryReader { proxy in
                    Color.clear.preference(key: TextHeightKey.self, value: proxy.size.height)
                }
            )
            .onPreferenceChange(TextHeightKey.self) { fullHeight = $0 }
            .frame(height: targetHeight, alignment: .top)
            .clipped()
            // A hidden single-line probe in the same font gives an exact line
            // height, including line spacing, without hard-coding a constant.
            .background(
                Text(" ")
                    .font(AppFont.sans(size: 12))
                    .fixedSize()
                    .hidden()
                    .background(
                        GeometryReader { proxy in
                            Color.clear.preference(key: LineHeightKey.self, value: proxy.size.height)
                        }
                    )
                    .onPreferenceChange(LineHeightKey.self) { lineHeight = $0 }
            )
    }
}

private struct TextHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

private struct LineHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

private struct ActionButton: View {
    let title: String
    let symbol: String
    let action: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: symbol).font(.system(size: 9, weight: .medium))
                Text(title).font(AppFont.sans(size: 11, weight: .medium))
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(isHovering ? Palette.hover : .clear)
                    .overlay(
                        RoundedRectangle(cornerRadius: 6)
                            .strokeBorder(Palette.separator, lineWidth: 1)
                    )
            )
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
    }
}
