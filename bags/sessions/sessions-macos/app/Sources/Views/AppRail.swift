import AppKit
import BarrySessionsCore
import Components
import SwiftUI

/// The rail of apps to leave the popover for.
///
/// A vertical pill rather than four glyphs on the end of the tab row: these are
/// apps, not tabs, and a column of marks says so. It is also why the rail stays
/// up while a session is open — the tab row hides there because a second
/// horizontal row read as competing navigation, which a column beside the
/// window does not do.
///
/// `AppRailPanel` hosts this in its own window, floating outside the popover's
/// right edge. The view itself knows nothing about that: it lays out a pill and
/// draws whatever icons it is handed.
struct AppRail: View {
    let icons: [AppRailIcon]
    let onOpen: (AppRailEntry) -> Void

    var body: some View {
        VStack(spacing: 6) {
            ForEach(icons) { icon in
                AppRailButton(icon: icon, onOpen: onOpen)
            }
        }
        .padding(.vertical, 8)
        .frame(width: 44)
        .background {
            Capsule()
                .fill(.ultraThinMaterial)
                .overlay(Capsule().strokeBorder(Palette.separator, lineWidth: 1))
        }
        .shadow(color: .black.opacity(0.18), radius: 8, y: 2)
        .frame(width: 56)
    }
}

private struct AppRailButton: View {
    let icon: AppRailIcon
    let onOpen: (AppRailEntry) -> Void

    @State private var isHovering = false

    var body: some View {
        Button {
            // A missing app says so instead of doing nothing. The launcher only
            // logs, which from here is a button that looks fine and is dead.
            if icon.isReachable {
                onOpen(icon.entry)
            } else {
                AppRailIconResolver.reportMissing(icon)
            }
        } label: {
            artwork
                .frame(width: 44, height: 44)
                .background(
                    Circle()
                        .fill(isHovering ? Palette.hover : Color.clear)
                        .frame(width: 36, height: 36)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(icon.isReachable ? icon.entry.help : "\(icon.entry.title) isn't installed")
        .accessibilityIdentifier(icon.entry.accessibilityIdentifier)
        // The identifier stays put in both states so scripted QA can still find
        // the button; the label is what carries the broken state.
        .accessibilityLabel(
            icon.isReachable ? icon.entry.title : "\(icon.entry.title), not installed"
        )
        .onHover { hovering in
            // Matches the cross-fade used by event rows; an instant swap
            // flickers when the pointer crosses quickly.
            withAnimation(.easeOut(duration: 0.12)) { isHovering = hovering }
        }
    }

    @ViewBuilder
    private var artwork: some View {
        glyph
            .foregroundStyle(tint)
            // Amber, not red: this is "never set up", not "just failed". The
            // badge carries the message — a merely dimmed icon reads as
            // temporarily disabled, which invites waiting rather than fixing.
            .overlay(alignment: .bottomTrailing) {
                if !icon.isReachable {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 8))
                        .foregroundStyle(Palette.amber)
                        .background(
                            Circle()
                                .fill(Palette.windowBackground)
                                .frame(width: 11, height: 11)
                        )
                        .offset(x: 4, y: 4)
                }
            }
    }

    /// The drawn mark, or the SF Symbol when the asset did not ship.
    @ViewBuilder
    private var glyph: some View {
        if let art = icon.art {
            // Template art: `foregroundStyle` supplies the color, so one black
            // asset covers both appearances and every state.
            Image(nsImage: art)
                .renderingMode(.template)
                .resizable()
                .frame(width: 26, height: 26)
        } else {
            Image(systemName: icon.entry.symbolName)
                .font(.system(size: 15))
        }
    }

    private var tint: Color {
        icon.isReachable ? .secondary : Palette.amber.opacity(0.55)
    }
}
