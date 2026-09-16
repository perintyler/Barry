import AppKit
import BarrySessionsCore

/// Finds the copy of a sibling Barry app that should be opened.
///
/// Extracted so the launcher and the app rail cannot disagree. The rail draws
/// an app's icon from its bundle and the launcher opens one; deriving the path
/// twice lets them drift, which shows the icon of one build while opening
/// another — the same stale-binary confusion `BarryAppLocation.resolve` was
/// written to prevent, one level up.
@MainActor
enum BarryAppBundle {
    /// The copy of `app` to open, or nil when it is not installed anywhere.
    ///
    /// Nil is a real answer, not an error to swallow: callers must show it.
    /// An absent app that looks identical to a present one is a button that
    /// reads as working and does nothing.
    static func url(for app: BarryAppLocation) -> URL? {
        // Prefer the installed bundle. Falling back to a bundle-id lookup
        // covers a machine where it was installed somewhere else.
        let installedBundle = app.installedBundle(
            home: FileManager.default.homeDirectoryForCurrentUser
        )
        return app.resolve(
            installed: FileManager.default.fileExists(atPath: installedBundle.path) ? installedBundle : nil,
            registered: NSWorkspace.shared.urlForApplication(withBundleIdentifier: app.bundleIdentifier)
        )
    }

    /// Where `url(for:)` looked, for messages that tell the user how to fix it.
    static func expectedPath(for app: BarryAppLocation) -> String {
        app.installedBundle(
            home: FileManager.default.homeDirectoryForCurrentUser
        ).path
    }
}
