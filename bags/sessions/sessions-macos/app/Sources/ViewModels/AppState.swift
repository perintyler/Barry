import BarryKit
import BarrySessionsCore
import Combine
import SwiftUI

/// Top-level app state: session list, connection status, and change tracking.
///
/// Sessions arrive over the realtime bus (`updateSession` publishes the
/// `sessions` topic from whichever process wrote the row — API, MCP, or CLI).
/// A slow poll stays behind it purely as a safety net for a dropped socket.
@Observable
final class AppState: @unchecked Sendable {
    var activeSessions: [Session] = []
    var recentSessions: [Session] = []
    var isConnected = false
    var selectedSessionId: String? {
        didSet {
            guard selectedSessionId != oldValue else { return }
            selectedSession = selectedSessionId.flatMap { sessionsById[$0] }
        }
    }
    var hasMoreRecent = true
    private var recentCursor: String?
    var isLoadingMore = false

    private let client = BarryClient()
    private var pollTimer: Timer?
    private var bus: BusClient?
    /// Supplied by the app shell so every feature shares one socket. When nil,
    /// `startBus()` builds a private client — the pre-merge behaviour, still
    /// used by tests and previews.
    private let sharedBus: BusClient?
    private let recentPageSize = 20
    /// In-flight coalesced bus refresh, cancelled and rescheduled per frame.
    private var busRefreshTask: Task<Void, Never>?
    private let busRefreshDebounce = 300

    init(bus: BusClient? = nil) {
        self.sharedBus = bus
    }

    /// Safety net only — the bus is the real update path. Long enough that a
    /// healthy socket makes this effectively free, short enough that a socket
    /// stuck down still eventually catches up.
    private let fallbackPollInterval: TimeInterval = 60

    /// All sessions: deduplicated and sorted by last message time (most recent first).
    /// Active sessions are merged with recent to avoid duplicates.
    ///
    /// Stored, not computed. As a computed property this rebuilt a Set, three
    /// arrays and a full sort on *every read* — and it was read at least four
    /// times per frame (twice by the list for `isEmpty` + `ForEach`, twice by
    /// `ContentView` via `selectedSession`). Under a burst of refreshes that
    /// alone could saturate the main thread. It is rebuilt once per mutation
    /// instead, the same way `MessagesState.commit(_:)` caches its segments.
    private(set) var sessions: [Session] = []

    /// The subset the list actually renders: sessions with no messages are
    /// hidden. Derived here so the view reads a stored array instead of
    /// re-filtering a freshly sorted one on every body pass.
    private(set) var visibleSessions: [Session] = []

    /// Selected row, resolved by id, so `ContentView` does not pay for a scan
    /// (previously a full re-sort) twice per pass.
    private(set) var selectedSession: Session?

    private var sessionsById: [String: Session] = [:]

    /// Recompute everything derived from `activeSessions` + `recentSessions`.
    /// Call after any mutation of either — and only then.
    private func rebuildSessions() {
        let activeIds = Set(activeSessions.map(\.id))
        let dedupedRecent = recentSessions.filter { !activeIds.contains($0.id) }
        let all = activeSessions + dedupedRecent

        // Sort on a precomputed key rather than reaching through two optionals
        // inside the comparator: `sorted` calls its predicate O(n log n) times,
        // so that work belongs in the decoration, not the comparison.
        sessions =
            all
            .map { (session: $0, key: $0.lastMessageAt ?? $0.createdAt ?? "") }
            .sorted { $0.key > $1.key }
            .map(\.session)

        visibleSessions = sessions.filter(\.hasMessages)
        sessionsById = Dictionary(sessions.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        selectedSession = selectedSessionId.flatMap { sessionsById[$0] }
    }

    // MARK: - Navigation

    /// Bumped whenever the app should return to the session list. `ContentView`
    /// watches this to clear the screen state it owns privately (search, sheet,
    /// scroll target), which this class can't reach.
    private(set) var homeResetToken = 0

    /// A tab the app should switch to, bumped with a token so the same request
    /// twice still registers.
    ///
    /// Same shape as `homeResetToken`, and for the same reason: the selected
    /// tab is `ContentView`'s private `@State`, which this class cannot reach.
    /// The delegate needs it for the Shutdown item, whose confirmation is drawn
    /// by the services tab — asking without switching would wait on an answer
    /// to a question nobody was shown.
    private(set) var requestedTab: RootTab?
    private(set) var requestedTabToken = 0

    func requestTab(_ tab: RootTab) {
        requestedTab = tab
        requestedTabToken &+= 1
    }

    /// Return to the session list, discarding whatever screen was open.
    ///
    /// Called when the popover closes so reopening the menu-bar item always
    /// lands on the home screen rather than resuming the previous session.
    func resetToHome() {
        selectedSessionId = nil
        homeResetToken &+= 1
    }

    // MARK: - Lifecycle

    @MainActor
    func start() {
        Task {
            await checkConnection()
            // UI-test hook: auto-select a seeded session so an AX client can reach
            // its Messages tab without navigating the (tap-gesture) session list.
            // Retry until the session appears in the list (draft creation races the
            // initial refresh), so selectedSession resolves and the detail renders.
            if let id = ProcessInfo.processInfo.environment["BARRY_UI_TEST_SESSION"] {
                for _ in 0..<20 {
                    await refreshSessionList()
                    if sessions.contains(where: { $0.id == id }) {
                        selectedSessionId = id
                        break
                    }
                    try? await Task.sleep(for: .milliseconds(250))
                }
            }
        }
        attachBus()
        startPolling()
    }

    func stop() {
        pollTimer?.invalidate()
        pollTimer = nil
        busRefreshTask?.cancel()
        busRefreshTask = nil
        Task { @MainActor [bus] in bus?.stop() }
    }

    // MARK: - Connection

    func checkConnection() async {
        let healthy = await client.checkHealth()
        // Only write when it actually changed: this runs on every bus frame,
        // and an unconditional assignment invalidates every observer of
        // `isConnected` at message rate.
        if healthy != isConnected {
            isConnected = healthy
        }
        if healthy {
            await refreshSessions()
        }
    }

    // MARK: - Sessions

    func refreshSessions() async {
        do {
            let fetched = try await client.fetchActiveSessions()
            // The bus fires on every session write from any process, and an
            // active session writes at message rate. Assigning an identical
            // array would still invalidate every observer, so compare first.
            if fetched != activeSessions {
                activeSessions = fetched
                rebuildSessions()
            }
        } catch {
            // Keep existing on transient failure
        }

        // Load first page of recent if empty
        if recentSessions.isEmpty {
            await loadMoreRecent()
        }
    }

    /// Full refresh: reload active sessions and reset the recent list from scratch.
    func refreshSessionList() async {
        do {
            activeSessions = try await client.fetchActiveSessions()
        } catch {
            // Keep existing on transient failure
        }
        recentSessions = []
        recentCursor = nil
        hasMoreRecent = true
        rebuildSessions()
        await loadMoreRecent()
    }

    /// Fetch the next page(s) of recent sessions.
    ///
    /// Keeps paging while a page adds nothing the list will render. The list
    /// hides sessions with no messages, but the load-more sentinel is armed
    /// from the server's cursor — so a run of message-less sessions used to
    /// leave the sentinel on screen with nothing gained, re-firing `onAppear`
    /// and paging the whole table while the main thread re-laid out the list
    /// each time. That is the wedge this loop closes: one firing either makes
    /// visible progress or exhausts its budget, then stops.
    ///
    /// `SessionPaging.maxPagesPerFetch` bounds the slice so a long empty run
    /// does not hold the main actor; the sentinel resumes where this left off.
    func loadMoreRecent() async {
        guard hasMoreRecent, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }

        var pagesFetched = 0

        while true {
            let visibleBefore = visibleSessions.count

            do {
                let response = try await client.fetchRecentSessions(
                    limit: recentPageSize,
                    cursor: recentCursor
                )
                recentSessions.append(contentsOf: response.sessions)
                recentCursor = response.nextCursor
                hasMoreRecent = response.nextCursor != nil
                rebuildSessions()
            } catch {
                // Keep existing on failure, and stop paging: retrying a failing
                // request in a tight loop is the same spin in another costume.
                return
            }

            pagesFetched += 1

            guard
                SessionPaging.shouldFetchAnotherPage(
                    gainedVisibleRows: visibleSessions.count > visibleBefore,
                    hasMoreServerRows: hasMoreRecent,
                    pagesFetched: pagesFetched
                )
            else { return }
        }
    }

    func renameSession(sessionId: String, name: String) async throws {
        try await client.renameSession(sessionId: sessionId, name: name)
        await refreshSessions()
    }

    func togglePin(sessionId: String, pinned: Bool) async throws {
        try await client.updatePinned(sessionId: sessionId, pinned: pinned)
        await refreshSessions()
    }

    // MARK: - Realtime

    /// Coalesce a burst of bus frames into one refresh.
    ///
    /// The socket says only "session X changed", so every frame triggers the
    /// same full refetch — and a running session emits at message rate. Without
    /// this, a busy session drives a refetch, a whole-list rebuild and a relayout
    /// per message. The delay is short enough to still read as realtime.
    @MainActor
    private func scheduleBusRefresh() {
        busRefreshTask?.cancel()
        // Read outside the closure: capturing `self` merely to reach a constant
        // is an error under the Swift 6 language mode.
        let delay = busRefreshDebounce
        busRefreshTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(delay))
            guard !Task.isCancelled, let self else { return }
            await self.checkConnection()
        }
    }

    /// Subscribe to the `sessions` topic so a write in any process refreshes the
    /// list immediately, instead of waiting out a poll interval.
    ///
    /// The socket carries no row data — only "session X changed" — so the
    /// handler refetches over REST exactly as the poll did. That keeps the
    /// NOTIFY envelope tiny and means a missed frame is never lost state, just a
    /// delayed refresh the fallback poll will pick up.
    /// Register the `sessions` handler on the bus.
    ///
    /// Synchronous and idempotent on purpose. The app shell calls this during
    /// `setup()` so the shared socket cannot connect before a subscriber
    /// exists; `start()` also calls it, which keeps the standalone path (and
    /// tests, and previews) working. Whichever runs first wins and the other
    /// is a no-op — subscribing twice would refetch twice per frame.
    @MainActor
    func attachBus() {
        guard bus == nil else { return }

        // The WS upgrade needs BARRY_SECRET even from localhost, so the
        // endpoint and secret come from the same launchd config the REST
        // client already uses.
        // Reuse the app-wide socket when the shell provided one. Building a
        // second client here would open a second connection carrying a
        // single topic.
        let bus = sharedBus ?? {
            let core = BarryCore()
            return BusClient(baseURL: core.baseURL, secret: core.authToken, topics: ["sessions"])
        }()

        bus.subscribe("sessions") { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in self.scheduleBusRefresh() }
        }
        self.bus = bus

        // Only start a client we created; a shared one is started by its owner
        // once every feature has subscribed.
        if sharedBus == nil { bus.start() }
    }

    // MARK: - Polling

    /// Fallback for a socket that is down; the bus handles the normal case.
    private func startPolling() {
        pollTimer?.invalidate()
        pollTimer = Timer.scheduledTimer(withTimeInterval: fallbackPollInterval, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in
                await self.checkConnection()
            }
        }
    }
}
