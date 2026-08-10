import Foundation

/// Pure, UI-independent bus logic — split out of `BusClient` so it can be
/// unit-tested without standing up a socket or an executable target.
public enum BusProtocol {
    /// Reconnect delay for the Nth consecutive failure (1-based), doubling and
    /// capped so a server that stays down doesn't get hammered.
    public static func reconnectDelay(attempt: Int, cap: TimeInterval = 30) -> TimeInterval {
        guard attempt > 0 else { return 0 }
        // pow() overflows into .infinity well before Int does, and min() would
        // happily return it, so clamp the exponent first.
        let exponent = min(Double(attempt - 1), 16)
        return min(pow(2, exponent), cap)
    }

    /// The topic named by a server frame, or nil if it isn't a bus message.
    ///
    /// Anything unrecognised returns nil rather than throwing: the socket
    /// carries session traffic too, and an unknown frame must not be treated as
    /// a change signal.
    public static func topic(fromFrame text: String) -> String? {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["type"] as? String == "bus",
              let topic = object["topic"] as? String,
              !topic.isEmpty
        else { return nil }
        return topic
    }

    /// Frame that subscribes to a topic.
    public static func subscribeFrame(topic: String) -> String? {
        encode(["type": "subscribe_topic", "topic": topic])
    }

    public static func unsubscribeFrame(topic: String) -> String? {
        encode(["type": "unsubscribe_topic", "topic": topic])
    }

    private static func encode(_ payload: [String: String]) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Build the WebSocket URL from the API base URL, preserving the host and
    /// upgrading the scheme (the API is reachable over both http and https).
    public static func socketURL(apiBaseURL: URL) -> URL? {
        guard var components = URLComponents(url: apiBaseURL, resolvingAgainstBaseURL: false) else { return nil }
        components.scheme = (apiBaseURL.scheme == "https") ? "wss" : "ws"
        components.path = "/api/v1/ws"
        return components.url
    }
}

/// Reconnect bookkeeping, separated from the socket so the state machine can be
/// tested without opening a connection.
///
/// The rules that matter: a successful read resets the backoff (so a flaky link
/// doesn't inherit a 30s delay from an earlier outage), and an explicit stop
/// permanently suppresses reconnects (so `stop()` during a pending retry doesn't
/// resurrect the socket).
public struct ReconnectPolicy {
    public private(set) var attempts = 0
    public private(set) var isStopped = false

    private let cap: TimeInterval

    public init(cap: TimeInterval = 30) {
        self.cap = cap
    }

    /// Register a failure and return how long to wait, or nil if stopped.
    public mutating func nextDelay() -> TimeInterval? {
        guard !isStopped else { return nil }
        attempts += 1
        return BusProtocol.reconnectDelay(attempt: attempts, cap: cap)
    }

    /// A message arrived — the connection is healthy again.
    public mutating func recordSuccess() {
        attempts = 0
    }

    public mutating func stop() {
        isStopped = true
    }

    public mutating func start() {
        isStopped = false
        attempts = 0
    }
}
