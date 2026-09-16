import Foundation

/// WebSocket client for Barry's realtime bus.
///
/// Replaces polling for the common case: the server pushes a small signal when a
/// topic changes and the app refetches over REST. The socket is best-effort —
/// `AppState` keeps a slow poll running as a safety net — so every failure path
/// here degrades to "reconnect and let the poll cover the gap" rather than
/// surfacing an error.
///
/// Note the API requires `BARRY_SECRET` on the upgrade even from localhost
/// (unlike its HTTP routes), so the header is not optional in practice.
@MainActor
public final class BusClient {
    /// Called when a subscribed topic changes, with the topic's name.
    ///
    /// One client can carry every topic the app cares about — the server keys
    /// subscriptions per socket, so `topics: ["sessions", "events"]` is one
    /// connection, not two. The owner switches on the name to decide what to
    /// refetch.
    public var onTopicChanged: ((String) -> Void)?

    private let baseURL: URL
    private let secret: String?
    private let topics: Set<String>

    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var policy = ReconnectPolicy(cap: 30)

    /// Per-topic subscribers, so several features can share one connection.
    private var subscribers: [String: [(String) -> Void]] = [:]

    public init(baseURL: URL, secret: String?, topics: Set<String>) {
        self.baseURL = baseURL
        self.secret = secret
        self.topics = topics
    }

    /// Register interest in a topic this client already subscribes to.
    ///
    /// The merged app has one socket carrying every topic, so a single
    /// `onTopicChanged` closure would mean whichever feature registered last
    /// silently won. Handlers accumulate here instead.
    ///
    /// The topic must be in the set passed to `init`; subscribing to one that
    /// was never sent to the server would register a handler that can never
    /// fire, which is a wiring mistake rather than a runtime condition.
    public func subscribe(_ topic: String, _ handler: @escaping (String) -> Void) {
        precondition(
            topics.contains(topic),
            "BusClient subscribed to '\(topic)' but was constructed with \(topics.sorted())"
        )
        subscribers[topic, default: []].append(handler)
    }

    /// Deliver a topic change to `onTopicChanged` and every registered handler.
    func deliver(topic: String) {
        onTopicChanged?(topic)
        for handler in subscribers[topic] ?? [] { handler(topic) }
    }

    public func start() {
        policy.start()
        connect()
    }

    public func stop() {
        policy.stop()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    // MARK: - Connection

    private func connect() {
        guard !policy.isStopped else { return }

        guard let url = BusProtocol.socketURL(apiBaseURL: baseURL) else { return }

        var request = URLRequest(url: url)
        if let secret { request.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization") }

        let session = URLSession(configuration: .default)
        let task = session.webSocketTask(with: request)
        self.session = session
        self.task = task

        task.resume()
        subscribeAll()
        receive()
    }

    /// The server forgets subscriptions when a socket closes, so these are
    /// re-sent on every connect, not just the first.
    private func subscribeAll() {
        for topic in topics {
            guard let frame = BusProtocol.subscribeFrame(topic: topic) else { continue }
            send(frame)
        }
    }

    private func send(_ frame: String) {
        guard let task else { return }
        task.send(.string(frame)) { _ in /* a dropped send is covered by reconnect + poll */ }
    }

    private func receive() {
        task?.receive { [weak self] result in
            Task { @MainActor in
                guard let self, !self.policy.isStopped else { return }
                switch result {
                case .success(let message):
                    self.handle(message)
                    self.policy.recordSuccess()
                    self.receive() // queue the next read
                case .failure:
                    self.scheduleReconnect()
                }
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        guard case .string(let text) = message,
              let topic = BusProtocol.topic(fromFrame: text)
        else { return }

        deliver(topic: topic)
    }

    private func scheduleReconnect() {
        task = nil
        guard let delay = policy.nextDelay() else { return } // nil once stopped

        Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            // stop() may have landed while this retry was sleeping.
            guard !self.policy.isStopped else { return }
            self.connect()
        }
    }
}
