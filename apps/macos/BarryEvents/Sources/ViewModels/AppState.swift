import SwiftUI
import AppKit

/// Feed state: polling, pagination, and read tracking.
///
/// Polling only ever refreshes the *first* page and merges by id, so pages the
/// user has scrolled into stay loaded and the scroll position survives a refresh.
@MainActor
final class AppState: ObservableObject {
    @Published private(set) var events: [BarryEvent] = []
    @Published private(set) var unreadCount = 0
    @Published private(set) var isLoadingMore = false
    @Published private(set) var hasMore = false
    @Published private(set) var lastRefresh: Date?
    @Published private(set) var errorMessage: String?
    @Published private(set) var hasLoadedOnce = false

    /// Set by the app delegate so notifications are suppressed while visible.
    var isPopoverOpen = false

    let webBaseURL: URL

    private let client: EventsClient
    private let bus: BusClient
    private let notifier = Notifier()
    private var nextCursor: String?
    private var timers: [Timer] = []
    /// Newest event we have already notified about — the high-water mark that
    /// keeps a refresh from re-announcing the whole feed.
    private var lastNotifiedAt: Date?

    private let pageSize = 40

    init() {
        let (baseURL, secret) = BarryConfig.apiEndpoint()
        self.client = EventsClient(baseURL: baseURL, secret: secret)
        self.bus = BusClient(baseURL: baseURL, secret: secret, topics: ["events"])
        self.webBaseURL = BarryConfig.webBaseURL()
    }

    // MARK: - Lifecycle

    func start() {
        notifier.requestAuthorization()
        refresh()

        // The bus pushes a signal when events change; this only refetches when
        // something actually happened, instead of asking twice a second.
        bus.onTopicChanged = { [weak self] topic in
            guard topic == "events" else { return }
            self?.refresh()
        }
        bus.start()

        // Safety net for a dropped socket — deliberately slow, since the bus is
        // the real update path.
        schedule(every: 60) { [weak self] in self?.refresh() }
    }

    func stop() {
        bus.stop()
        for timer in timers { timer.invalidate() }
        timers.removeAll()
    }

    private func schedule(every seconds: TimeInterval, _ body: @escaping () -> Void) {
        let timer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: true) { _ in
            Task { @MainActor in body() }
        }
        timers.append(timer)
    }

    // MARK: - Loading

    func refresh() {
        Task {
            do {
                let page = try await client.fetchEvents(limit: pageSize)
                merge(firstPage: page.events, nextCursor: page.nextCursor)
                errorMessage = nil
                lastRefresh = Date()
                hasLoadedOnce = true
            } catch {
                errorMessage = error.localizedDescription
                hasLoadedOnce = true
            }
        }
    }

    func loadMore() {
        guard let cursor = nextCursor, !isLoadingMore else { return }
        isLoadingMore = true
        Task {
            defer { isLoadingMore = false }
            guard let page = try? await client.fetchEvents(limit: pageSize, cursor: cursor) else { return }
            let known = Set(events.map(\.id))
            events.append(contentsOf: page.events.filter { !known.contains($0.id) })
            nextCursor = page.nextCursor
            hasMore = page.nextCursor != nil
        }
    }

    /// Replace the newest page while preserving anything already paged in below it.
    private func merge(firstPage: [BarryEvent], nextCursor cursor: String?) {
        let fresh = Set(firstPage.map(\.id))
        let older = events.filter { !fresh.contains($0.id) }
        let combined = firstPage + older

        // Only announce events newer than the last one we notified about.
        if let newest = firstPage.first?.createdAt {
            if let mark = lastNotifiedAt {
                let unseen = firstPage.filter { $0.createdAt > mark && $0.isUnread }
                if !isPopoverOpen { notifier.notify(about: unseen, webBaseURL: webBaseURL) }
            }
            lastNotifiedAt = max(lastNotifiedAt ?? newest, newest)
        }

        events = combined
        unreadCount = combined.filter(\.isUnread).count
        // Only trust the cursor when this is the deepest page we hold.
        if older.isEmpty {
            nextCursor = cursor
            hasMore = cursor != nil
        } else if nextCursor == nil {
            nextCursor = cursor
            hasMore = cursor != nil
        }
    }

    // MARK: - Actions

    func markRead(_ event: BarryEvent) {
        guard event.isUnread else { return }
        applyRead(to: event.id)
        Task { try? await client.markRead(event.id) }
    }

    func markAllRead() {
        guard unreadCount > 0 else { return }
        events = events.map { $0.isUnread ? $0.markingRead() : $0 }
        unreadCount = 0
        Task {
            try? await client.markAllRead()
            refresh()
        }
    }

    func open(_ event: BarryEvent) {
        markRead(event)

        // Same routing as a notification click, so a row and its banner behave
        // identically.
        if case .string("pack_auth") = event.data["action"] {
            let packs = event.authPacks
            if !packs.isEmpty {
                Task { await authorizePacks(packs) }
                return
            }
        }

        guard let sessionId = event.sessionId else { return }
        NSWorkspace.shared.open(
            webBaseURL.appendingPathComponent("sessions").appendingPathComponent(sessionId)
        )
    }

    /// Start the OAuth flow for packs that need it.
    ///
    /// The server owns the flow — mcp-remote opens the browser tab, on a
    /// callback port only it knows — so this just asks it to begin. The endpoint
    /// is single-flight per pack, so repeated clicks can't stack up tabs.
    func authorizePacks(_ packs: [String]) async {
        for pack in packs {
            await client.startPackAuth(pack)
        }
    }

    private func applyRead(to id: String) {
        guard let index = events.firstIndex(where: { $0.id == id }) else { return }
        events[index] = events[index].markingRead()
        unreadCount = max(0, unreadCount - 1)
    }
}

private extension BarryEvent {
    /// Optimistic local read — avoids waiting a poll cycle for the badge to drop.
    func markingRead() -> BarryEvent {
        BarryEvent(
            id: id, type: type, sessionId: sessionId, source: source,
            title: title, body: body, severity: severity, data: data,
            readAt: Date(), createdAt: createdAt
        )
    }
}
