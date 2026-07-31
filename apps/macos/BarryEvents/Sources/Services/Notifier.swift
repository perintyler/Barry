import Foundation
import UserNotifications

/// Posts macOS notifications for events that arrive while the popover is closed.
///
/// Delivery is best-effort: if the user denies authorization, or the process is
/// running unbundled (where `UNUserNotificationCenter` is unavailable), every
/// call quietly no-ops rather than failing the refresh that triggered it.
@MainActor
final class Notifier {
    /// Beyond this many new events at once, collapse the rest into one summary
    /// notification instead of stacking a wall of banners.
    private let individualLimit = 3
    private var isAuthorized = false

    func requestAuthorization() {
        guard Bundle.main.bundleIdentifier != nil else { return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
            Task { @MainActor in self.isAuthorized = granted }
        }
    }

    func notify(about events: [BarryEvent], webBaseURL: URL) {
        guard isAuthorized, !events.isEmpty else { return }

        for event in events.prefix(individualLimit) {
            let content = UNMutableNotificationContent()
            content.title = event.type.label.capitalized
            content.body = event.displayTitle
            content.sound = event.severity == .error ? .defaultCritical : .default
            content.userInfo = clickPayload(for: event, webBaseURL: webBaseURL)
            submit(content, id: event.id)
        }

        let overflow = events.count - individualLimit
        if overflow > 0 {
            let content = UNMutableNotificationContent()
            content.title = "Barry"
            content.body = "+\(overflow) more event\(overflow == 1 ? "" : "s")"
            submit(content, id: "overflow-\(events.first?.id ?? "")")
        }
    }

    /// What a click on this notification should do.
    ///
    /// Events opt into an action by setting `data.action` server-side, which
    /// keeps routing out of string-matching on titles. Anything without one
    /// falls back to opening its session, and an event with neither is simply
    /// not clickable.
    private func clickPayload(for event: BarryEvent, webBaseURL: URL) -> [String: Any] {
        if case .string("pack_auth") = event.data["action"] {
            let packs = event.authPacks
            if !packs.isEmpty {
                return ["action": "pack_auth", "packs": packs]
            }
        }

        if let sessionId = event.sessionId {
            return ["sessionURL": webBaseURL
                .appendingPathComponent("sessions")
                .appendingPathComponent(sessionId).absoluteString]
        }

        return [:]
    }

    private func submit(_ content: UNMutableNotificationContent, id: String) {
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: id, content: content, trigger: nil)
        )
    }
}
