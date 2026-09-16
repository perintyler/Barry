import Foundation

/// Which health states represent something a person should look at.
///
/// This is deliberately narrower than "not green". A scheduled job sits idle
/// between firings by design, so counting it as a problem would mean the badge
/// is never clear and therefore never worth reading. Only a service that is
/// supposed to be up and is not — or is up but failing its health check —
/// counts as needing attention.
public enum AttentionLevel: Sendable {
    /// Alive but failing its health endpoint.
    case unhealthy
    /// Expected to be running, and is not.
    case down
}

/// Whether a service in this state needs attention, and at what level.
///
/// Being stopped is only a fault if something was supposed to keep the service
/// up. Three kinds of agent rest at "not running" as their normal state:
///
///   - scheduled agents, idle between firings (`isScheduled`)
///   - run-once scripts that did their job and exited (`expectedToStayUp`
///     false — `RunAtLoad` with no `KeepAlive` and no timer, e.g.
///     `bag.coffee.reconcile`, whose last exit code is 0)
///   - fire-and-forget apps, whose liveness is judged by process lookup
///     before this is ever consulted
///
/// Flagging any of them would leave the badge permanently lit over a service
/// that is working exactly as designed, which trains the reader to ignore it —
/// the precise failure this count exists to avoid.
public func attentionLevel(
    isAlive: Bool,
    healthCheckPassed: Bool?,
    isScheduled: Bool,
    expectedToStayUp: Bool = true
) -> AttentionLevel? {
    if isAlive {
        // A failing health check on a live process is the most actionable
        // state there is: the process is up, so nothing will restart it.
        return healthCheckPassed == false ? .unhealthy : nil
    }
    guard !isScheduled, expectedToStayUp else { return nil }
    return .down
}
