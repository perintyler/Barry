import AppKit
import BarrySessionsCore
import SwiftUI

/// The floating rail that sits outside the popover's right edge.
///
/// A popover cannot draw outside its own frame, so a rail that floats beside it
/// has to be a second window. That window is the delicate part: the popover is
/// `.transient` and closes as soon as another window takes focus, so an
/// ordinary panel would dismiss the very thing it is attached to the moment it
/// appeared — and again on every click.
///
/// Three things keep that from happening, and all three are load-bearing:
///
/// * `.nonactivatingPanel` plus `becomesKeyOnlyIfNeeded` — the panel never
///   becomes key, so showing it and clicking it do not count as the kind of
///   activation that dismisses a transient popover.
/// * `isFloatingPanel` with `.popUpMenu` level — it stays above the popover
///   without joining the normal window ordering.
/// * `hidesOnDeactivate` — when the user switches to another app the popover
///   vanishes on its own; without this the rail would be left behind on screen,
///   pointing at nothing.
@MainActor
final class AppRailPanel {
    private var panel: NSPanel?
    private let onOpen: (AppRailEntry) -> Void

    /// Geometry lives in `AppRailPlacement` (Core) so the part that can be
    /// wrong without looking wrong is testable.
    private static var width: CGFloat { AppRailPlacement.width }

    init(onOpen: @escaping (AppRailEntry) -> Void) {
        self.onOpen = onOpen
    }

    /// Show the rail beside `popover`, or move it if already up.
    ///
    /// Resolving icons here rather than once at init means an app installed
    /// while the popover was closed shows up on the next open.
    func show(beside popover: NSPopover) {
        guard let anchor = popover.contentViewController?.view.window else {
            // No window yet: the popover was asked to show but has not been
            // placed. Nothing useful to attach to, and guessing a position
            // would put the rail somewhere arbitrary on screen.
            NSLog("App rail: popover has no window to attach to")
            return
        }

        let icons = AppRailIconResolver.resolveAll()
        let host = NSHostingView(
            rootView: AppRail(icons: icons, onOpen: onOpen)
                .frame(width: Self.width)
        )
        host.layoutSubtreeIfNeeded()

        // A hosting view that has not laid out yet reports zero, which would
        // size the panel to nothing: on screen, present, and invisible. Fall
        // back to the rail's natural height rather than showing a void.
        let measured = host.fittingSize.height
        let height = measured > 1 ? measured : AppRailPlacement.height(forEntries: icons.count)

        let panel = self.panel ?? makePanel()
        self.panel = panel
        panel.contentView = host
        panel.setFrame(Self.frame(beside: anchor.frame, height: height), display: true)

        // `order` rather than `makeKey`: taking key would dismiss the popover.
        panel.order(.above, relativeTo: anchor.windowNumber)
    }

    func hide() {
        panel?.orderOut(nil)
    }

    /// Keep the rail glued to the popover if the popover itself moves.
    func reposition(beside popover: NSPopover) {
        guard let panel, panel.isVisible,
              let anchor = popover.contentViewController?.view.window else { return }
        panel.setFrame(
            Self.frame(beside: anchor.frame, height: panel.frame.height),
            display: true
        )
    }

    private func makePanel() -> NSPanel {
        let panel = NSPanel(
            contentRect: .zero,
            styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.hidesOnDeactivate = true
        panel.level = .popUpMenu
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false // the rail draws its own
        panel.isMovable = false
        // Follow the popover across spaces rather than pinning to one.
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        return panel
    }

    private static func frame(beside anchor: NSRect, height: CGFloat) -> NSRect {
        AppRailPlacement.frame(
            beside: anchor,
            height: height,
            screen: NSScreen.main?.visibleFrame
        )
    }
}
