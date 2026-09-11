import AppKit
import BarrySessionsCore
import SwiftUI

/// A rail entry with its art resolved.
///
/// A value rather than something computed in `body`: resolving touches the
/// filesystem and the icon cache, and SwiftUI re-evaluates a rail body on every
/// hover.
struct AppRailIcon: Identifiable {
    let entry: AppRailEntry
    /// Nil when there is no app icon to draw, which means the entry falls back
    /// to its SF Symbol — either because it is a web destination, or because
    /// the app is missing.
    let appIcon: NSImage?
    /// False only for an app whose bundle could not be found.
    let isReachable: Bool

    var id: String { entry.id }

    /// Where the bundle was looked for, so a missing app can say how to fix it.
    let expectedPath: String?
}

@MainActor
enum AppRailIconResolver {
    static func resolveAll(_ entries: [AppRailEntry] = AppRailEntry.all) -> [AppRailIcon] {
        entries.map(resolve)
    }

    /// Resolve one entry.
    ///
    /// Order matters: reachability is decided from `BarryAppBundle.url(for:)`
    /// *before* any icon is requested. Asking `NSWorkspace` for the icon of a
    /// missing app returns a generic document icon rather than nil, so deciding
    /// afterwards would draw every absent app as a plausible button.
    static func resolve(_ entry: AppRailEntry) -> AppRailIcon {
        guard let location = entry.appLocation else {
            // A web destination: nothing on disk, so nothing to find missing.
            return AppRailIcon(
                entry: entry,
                appIcon: nil,
                isReachable: true,
                expectedPath: nil
            )
        }

        guard let url = BarryAppBundle.url(for: location) else {
            return AppRailIcon(
                entry: entry,
                appIcon: nil,
                isReachable: false,
                expectedPath: BarryAppBundle.expectedPath(for: location)
            )
        }

        return AppRailIcon(
            entry: entry,
            appIcon: NSWorkspace.shared.icon(forFile: url.path),
            isReachable: true,
            expectedPath: url.path
        )
    }

    /// Say what is wrong, where it was looked for, and how to fix it.
    ///
    /// Follows the missing-self-update-script alert in `main.swift` rather than
    /// inventing a second way to report a missing file. The launcher only
    /// `NSLog`s, which from the user's side is a button that does nothing.
    static func reportMissing(_ icon: AppRailIcon) {
        let alert = NSAlert()
        alert.messageText = "\(icon.entry.title) isn't installed"
        alert.informativeText = """
            Barry Sessions looked for \(icon.expectedPath ?? "the app bundle") \
            and asked Launch Services for it.

            Run scripts/launchd/setup to install it.
            """
        alert.alertStyle = .warning
        alert.runModal()
    }
}
