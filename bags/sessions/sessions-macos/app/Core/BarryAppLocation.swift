import Foundation

/// Where a sibling Barry app lives, and which copy to prefer.
///
/// Barry Sessions launches two other apps by bundle id — Identities and
/// Actions — and both want the same care about *which* copy opens. Pure and
/// separate from the launcher so it can be tested without launching anything.
///
/// The preference matters: `NSWorkspace`'s bundle-id lookup returns whichever
/// copy Launch Services saw most recently, which on a development machine is
/// usually a `.build` directory rather than the installed app. That silently
/// runs a stale or half-built binary from a button that looks like it opened
/// the real thing.
public struct BarryAppLocation: Sendable, Equatable {
    public let bundleIdentifier: String
    /// The bundle's name on disk, without `.app` — also the executable name,
    /// which is what `scripts/launchd/setup` keys the install path on.
    public let bundleName: String

    public init(bundleIdentifier: String, bundleName: String) {
        self.bundleIdentifier = bundleIdentifier
        self.bundleName = bundleName
    }

    /// The installed bundle path, matching where `scripts/launchd/setup` puts
    /// it (`getAppsDir()` in packages/env).
    public func installedBundle(home: URL) -> URL {
        home.appendingPathComponent(".barry/apps/\(bundleName).app")
    }

    /// Which copy to open, given whether the installed one exists and whatever
    /// Launch Services suggests.
    ///
    /// Installed wins. The registered fallback covers a machine where the app
    /// lives somewhere else; nil means it isn't installed at all, which the
    /// caller should report rather than swallow — a button that does nothing
    /// reads as broken.
    public func resolve(installed: URL?, registered: URL?) -> URL? {
        installed ?? registered
    }
}

public extension BarryAppLocation {
    /// Identity management. Its own app so this one can stay `.accessory`.
    static let identities = BarryAppLocation(
        bundleIdentifier: "com.barry.identities",
        bundleName: "BarryIdentities"
    )

    /// Reading action runs — their inputs, prompt and deliverable.
    static let actions = BarryAppLocation(
        bundleIdentifier: "com.barry.actions",
        bundleName: "BarryActions"
    )

    /// Writing and editing plans. Lives in the plans bag (bags/plans in the
    /// sibling bags repo), not this one — the location contract is identical
    /// because scripts/launchd/setup installs every bag app the same way.
    static let plans = BarryAppLocation(
        bundleIdentifier: "com.barry.plans",
        bundleName: "Plans"
    )
}
