import Foundation

/// Where the rebuild-and-relaunch script lives.
///
/// "Restart" rebuilds from source, so it needs the *repo*, and the running app
/// cannot point at it: it executes from `~/.barry/apps/BarrySessions.app`, an
/// installed copy with no path back to the checkout it was built from. So the
/// location is resolved by search rather than derived from the bundle.
///
/// Pure and separate from the menu action so the search order can be tested
/// without a filesystem or a running app.
public enum SelfUpdateLocation {
    /// Path of the script relative to a repo checkout root.
    public static let scriptSubpath = "bags/sessions/sessions-macos/app/scripts/self-update"

    /// Candidate checkout roots, in preference order.
    ///
    /// `BARRY_REPO` first so a worktree can restart into its own build — the
    /// whole point of the item during development, and the shared master tree
    /// is usually dirty with other sessions' work. `~/repos/barry` is the
    /// conventional location and covers the normal install.
    public static func candidateRoots(home: URL, environment: [String: String]) -> [URL] {
        var roots: [URL] = []
        if let override = environment["BARRY_REPO"], !override.isEmpty {
            roots.append(URL(fileURLWithPath: override))
        }
        roots.append(home.appendingPathComponent("repos/barry"))
        return roots
    }

    /// The first candidate whose script actually exists.
    ///
    /// - Parameter exists: existence probe, injected for testing.
    ///
    /// Returns nil when no checkout has it, which the caller must report rather
    /// than swallow. A "Restart" that silently does nothing is worse than one
    /// that says it cannot find the source — the user would otherwise sit
    /// waiting for an app that is never coming back.
    public static func resolveScript(
        home: URL,
        environment: [String: String],
        exists: (URL) -> Bool
    ) -> URL? {
        for root in candidateRoots(home: home, environment: environment) {
            let script = root.appendingPathComponent(scriptSubpath)
            if exists(script) { return script }
        }
        return nil
    }
}
