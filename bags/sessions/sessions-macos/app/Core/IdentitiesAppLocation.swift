import Foundation

/// Where the standalone Barry Identities app lives, and which copy to prefer.
///
/// Pure and separate from the launcher so it can be tested without launching
/// anything. The preference matters: `NSWorkspace`'s bundle-id lookup returns
/// whichever copy Launch Services saw most recently, which on a development
/// machine is usually a `.build` directory rather than the installed app. That
/// silently runs a stale or half-built binary from a button that looks like it
/// opened the real thing.
public enum IdentitiesAppLocation {
    public static let bundleIdentifier = "com.barry.identities"

    /// The installed bundle path, matching where `scripts/launchd/setup` puts
    /// it (`getAppsDir()` in packages/env).
    public static func installedBundle(home: URL) -> URL {
        home.appendingPathComponent(".barry/apps/BarryIdentities.app")
    }

    /// Which copy to open, given whether the installed one exists and whatever
    /// Launch Services suggests.
    ///
    /// Installed wins. The registered fallback covers a machine where the app
    /// lives somewhere else; nil means it isn't installed at all, which the
    /// caller should report rather than swallow — a button that does nothing
    /// reads as broken.
    public static func resolve(installed: URL?, registered: URL?) -> URL? {
        installed ?? registered
    }
}
