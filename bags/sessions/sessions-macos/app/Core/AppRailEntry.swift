import Foundation

/// One control in the right-edge app rail.
///
/// These are not tabs: each one leaves the popover rather than changing what is
/// in it — a browser dashboard, or a sibling app. They sit in a rail because
/// all of them lead to work you sit with, which a transient popover that closes
/// on any outside click is the wrong container for.
///
/// Pure, so the parts that are easy to get wrong and invisible when wrong — the
/// identifiers scripted QA presses, and whether an entry can do anything at all
/// — can be tested without a running app.
public struct AppRailEntry: Sendable, Equatable {
    /// What the entry opens.
    public enum Destination: Sendable, Equatable {
        /// A sibling Barry app, opened from its resolved bundle.
        case app(BarryAppLocation)
        /// A web dashboard. No bundle, so there is nothing on disk to find.
        case web(URL)
    }

    public let id: String
    public let title: String
    public let help: String
    /// Scripted QA presses these (see QA.md step 24), so they are a contract,
    /// not a detail.
    public let accessibilityIdentifier: String
    public let destination: Destination
    /// Drawn when there is no app icon to show: always for `.web`, and for an
    /// app whose bundle could not be found — which the rail renders as a
    /// visibly broken slot rather than a normal-looking button.
    public let symbolName: String

    public init(
        id: String,
        title: String,
        help: String,
        accessibilityIdentifier: String,
        destination: Destination,
        symbolName: String
    ) {
        self.id = id
        self.title = title
        self.help = help
        self.accessibilityIdentifier = accessibilityIdentifier
        self.destination = destination
        self.symbolName = symbolName
    }

    /// Whether this entry can actually do anything, given whether its bundle
    /// resolved.
    ///
    /// Deliberately decided from resolution rather than from whether an icon
    /// loaded. `NSWorkspace.icon(forFile:)` returns a generic document icon for
    /// a path that does not exist rather than nil, so an icon-based check would
    /// pass for an app that is not installed — a check that cannot fail.
    public func isReachable(bundleURL: URL?) -> Bool {
        switch destination {
        case .web:
            // Nothing local to verify. Whether the dashboard is actually up is
            // the browser's to report; claiming to know here would be a second
            // check that always passes.
            return true
        case .app:
            return bundleURL != nil
        }
    }

    /// The app this entry opens, or nil for a web destination.
    public var appLocation: BarryAppLocation? {
        switch destination {
        case .app(let location): return location
        case .web: return nil
        }
    }
}

public extension AppRailEntry {
    /// The metrics dashboard, served by Caddy on the LAN hostname rather than a
    /// port. Force-unwrapped because it is a compile-time constant: if this
    /// literal ever stops parsing as a URL, every launch should surface it, not
    /// one silently dead button.
    static let metricsURL = URL(string: "http://metrics.barry.lan")!

    static let metrics = AppRailEntry(
        id: "metrics",
        title: "Metrics",
        help: "Open metrics",
        accessibilityIdentifier: "OpenMetricsButton",
        destination: .web(metricsURL),
        symbolName: "chart.bar.xaxis"
    )

    static let identities = AppRailEntry(
        id: "identities",
        title: "Identities",
        help: "Manage identities",
        accessibilityIdentifier: "OpenIdentitiesButton",
        destination: .app(.identities),
        symbolName: "person.crop.circle"
    )

    static let actions = AppRailEntry(
        id: "actions",
        title: "Actions",
        help: "Read action runs",
        accessibilityIdentifier: "OpenActionsButton",
        destination: .app(.actions),
        symbolName: "checklist"
    )

    /// "map" rather than another list glyph: checklist is taken by actions, and
    /// the plans bag's identity everywhere else is the map — the favicon, the
    /// web tab, the repo.
    static let plans = AppRailEntry(
        id: "plans",
        title: "Plans",
        help: "Write and edit plans",
        accessibilityIdentifier: "OpenPlansButton",
        destination: .app(.plans),
        symbolName: "map"
    )

    /// Rail order, top to bottom. Kept as the icons already read left to right
    /// so the change is a move, not a reshuffle of something already learned.
    static let all: [AppRailEntry] = [metrics, identities, actions, plans]
}
