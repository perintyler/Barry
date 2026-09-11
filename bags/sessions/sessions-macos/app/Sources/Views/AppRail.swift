import AppKit
import BarrySessionsCore
import Components
import SwiftUI

/// The right-edge rail of apps to leave the popover for.
///
/// A vertical pill rather than four glyphs on the end of the tab row: these are
/// apps, not tabs, and showing their real icons says so. It is also why the
/// rail stays on screen while a session is open — the tab row hides there
/// because a second horizontal row read as competing navigation, which a
/// column on the far edge does not do.
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
        if let appIcon = icon.appIcon {
            // App icons are dense square art and read larger than a glyph at
            // the same box, so they get their own size.
            Image(nsImage: appIcon)
                .resizable()
                .frame(width: 26, height: 26)
        } else if icon.isReachable {
            Image(systemName: icon.entry.symbolName)
                .font(.system(size: 15))
                .foregroundStyle(.secondary)
        } else {
            // Amber, not red: this is "never set up", not "just failed". The
            // badge matters more than the tint — a merely dimmed icon reads as
            // temporarily disabled, which invites waiting rather than fixing.
            Image(systemName: icon.entry.symbolName)
                .font(.system(size: 15))
                .foregroundStyle(Palette.amber.opacity(0.55))
                .overlay(alignment: .bottomTrailing) {
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
}
