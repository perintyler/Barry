import SwiftUI

enum ConfirmActionKind { case stop, restart }

struct ConfirmAction {
    let label: String
    let kind: ConfirmActionKind
}

struct AliveResult {
    let id: String
    let alive: Bool
    let pid: Int?
}

@Observable
public final class ServicesState: @unchecked Sendable {
    public init() {}

    var services: [BarryService] = []
    var isLoading = true
    var lastRefresh: Date?
    var pendingActions: Set<String> = []
    var confirmingAction: ConfirmAction?
    var isShuttingDown = false
    var showShutdownConfirm = false
    var searchQuery = ""
    /// When on, the list shows only services in a faulty state.
    var showOnlyAttention = false

    private var pollTimer: Timer?
    /// True whenever the popover is open and Services is the visible tab —
    /// call `setVisible` from the popover's show/close handlers, not by
    /// calling `start()`/`stop()` directly from a view's `.task`. Before
    /// F13, `start()` ran once at app launch and NOTHING ever called `stop()`
    /// — the 5s poll timer ran for the entire app lifetime, popover open or
    /// closed, forever (confirmed: `stop()` had zero call sites anywhere in
    /// the app besides its own declaration).
    private var isVisible = false
    /// Guards `refresh()` against overlapping fetches — mirrors bdiff's
    /// `loadInFlight` guard (`bdiff/app/Sources/ViewModels/AppState.swift`):
    /// a plain `Bool` checked before starting a `Task`, cleared in `defer`.
    /// Without it, a slow `fetchServiceState()` (discovery + concurrent
    /// liveness/health checks) overlapping the next 5s tick would race two
    /// updates writing `self.services` in arbitrary completion order.
    /// `internal` (not `private`) so `@testable import` can observe the
    /// guard's own state transitions directly.
    private(set) var refreshInFlight = false

    // MARK: - Computed

    /// Services in a state worth looking at — stopped when they should be up,
    /// or alive but failing a health check.
    var attentionServices: [BarryService] {
        services.filter(\.needsAttention)
    }

    var attentionCount: Int { attentionServices.count }

    /// Services matching the current search and attention filter, in
    /// discovery order.
    var filteredServices: [BarryService] {
        var result = services
        if showOnlyAttention {
            result = result.filter(\.needsAttention)
        }
        let trimmed = searchQuery.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return result }
        return result.filter { svc in
            let parsed = parseServiceName(svc.id)
            return serviceMatches(
                query: searchQuery,
                name: parsed.name,
                owner: parsed.owner,
                label: svc.id
            )
        }
    }

    var grouped: [(ServiceCategory, [BarryService])] {
        let dict = Dictionary(grouping: filteredServices, by: \.category)
        return ServiceCategory.allCases.compactMap { cat in
            guard let svcs = dict[cat], !svcs.isEmpty else { return nil }
            return (cat, svcs)
        }
    }

    var isSearching: Bool {
        !searchQuery.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// True when a filter is active but nothing matched — distinct from having
    /// no services at all, which means something is wrong with discovery.
    var hasNoMatches: Bool {
        (isSearching || showOnlyAttention) && filteredServices.isEmpty && !services.isEmpty
    }

    /// The reason the list is empty, phrased for whichever filter is active.
    /// "All services healthy" is a genuinely different message from "no match"
    /// — one is good news, the other means try a different query.
    var noMatchesMessage: String {
        if showOnlyAttention && !isSearching {
            return "Every service is running normally."
        }
        if showOnlyAttention {
            return "No service needing attention matches “\(searchQuery)”."
        }
        return "No service matches “\(searchQuery)”."
    }

    /// Counts stay whole-fleet regardless of the filter: a search narrows what
    /// you look at, it should not look like services vanished.
    var runningCount: Int { services.filter { $0.isRunning }.count }

    // MARK: - Lifecycle

    /// Start polling. Call once, at app launch, with the popover closed by
    /// default — an immediate `refresh()` so the list isn't empty the first
    /// time the popover opens, then settle into the BACKGROUND cadence
    /// (matching `isVisible`'s own `false` default) until `setVisible(true)`
    /// fires from the first popover open. Visibility changes after that go
    /// through `setVisible`, not repeated `start()` calls from a view's
    /// `.task` (a prior version of `ServicesView` did exactly that, re-arming
    /// the timer on every tab appearance on top of the one already running
    /// from launch).
    public func start() {
        refresh()
        startPolling(interval: isVisible ? Self.foregroundInterval : Self.backgroundInterval)
    }

    /// Stop polling entirely. Kept for symmetry with `start()` and for
    /// shutdown paths that want no further background activity at all —
    /// normal popover close should call `setVisible(false)` instead, which
    /// keeps a slow background cadence alive for the menu-bar attention
    /// badge rather than going fully silent.
    public func stop() {
        isVisible = false
        pollTimer?.invalidate()
        pollTimer = nil
    }

    /// Switch polling cadence with visibility, rather than stopping outright.
    ///
    /// F13: before this, the 5s poll ran forever regardless of whether the
    /// popover was open — burning a plist-parse + concurrent liveness/health
    /// check fan-out every 5s even while nobody could see the result. But
    /// fully stopping while hidden would also blind the menu-bar badge to a
    /// service going down between popover opens, so hidden state polls on a
    /// slower 30s cadence instead of zero — enough to keep the attention
    /// count roughly current without paying the foreground cost.
    public func setVisible(_ visible: Bool) {
        guard visible != isVisible else { return }
        isVisible = visible
        if visible { refresh() }  // catch up immediately on becoming visible
        startPolling(interval: visible ? Self.foregroundInterval : Self.backgroundInterval)
    }

    // MARK: - Polling

    static let foregroundInterval: TimeInterval = 5
    static let backgroundInterval: TimeInterval = 30

    /// The poll interval currently in effect — `internal` (not `private`) so
    /// `@testable import` can assert on it without a real multi-second wait
    /// for the timer to actually fire.
    var currentPollInterval: TimeInterval? { pollTimer?.timeInterval }

    private func startPolling(interval: TimeInterval) {
        pollTimer?.invalidate()
        pollTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    // MARK: - Refresh

    /// Test-only seam: when set, `refresh()` calls this instead of the real
    /// `fetchServiceState()` (which shells out to `launchctl`/`pgrep` and is
    /// not something a unit test should depend on). `nil` in production —
    /// `refresh()` falls back to the real fetch whenever this is unset.
    var fetchOverride: (@Sendable () async -> [BarryService])?

    /// Counts real fetch invocations — test-only, incremented regardless of
    /// which fetch path ran. Exists specifically to let a test distinguish
    /// "the single-flight guard rejected the second call" (count stays 1)
    /// from "the guard is a no-op and both calls ran" (count reaches 2) —
    /// `refreshInFlight` eventually returning to `false` cannot tell those
    /// two outcomes apart on its own.
    private(set) var fetchCallCount = 0

    func refresh() {
        guard !refreshInFlight else { return }
        refreshInFlight = true
        Task {
            defer { refreshInFlight = false }
            fetchCallCount += 1
            let snapshot: [BarryService]
            if let override = fetchOverride {
                snapshot = await override()
            } else {
                snapshot = await fetchServiceState()
            }
            await MainActor.run {
                self.services = snapshot
                self.isLoading = false
                self.lastRefresh = Date()
                self.clearAttentionFilterIfResolved()
            }
        }
    }

    /// Turn the attention filter off once nothing needs attention. The badge
    /// that toggles it is only rendered while the count is above zero, so
    /// leaving the filter on after the last fault clears would strand the user
    /// on an empty list with no visible control to escape it.
    private func clearAttentionFilterIfResolved() {
        if showOnlyAttention && attentionCount == 0 {
            showOnlyAttention = false
        }
    }

    /// Fetch the current state of all services.
    private func fetchServiceState() async -> [BarryService] {
        let discovered = discoverServices()

        // Check process liveness for all services concurrently
        let aliveResults: [AliveResult] = await withTaskGroup(of: AliveResult.self) { group in
            for svc in discovered {
                let svcCopy = svc
                group.addTask {
                    let (alive, pid) = isServiceAlive(svcCopy)
                    return AliveResult(id: svcCopy.id, alive: alive, pid: pid)
                }
            }
            var results: [AliveResult] = []
            for await result in group { results.append(result) }
            return results
        }
        let aliveMap = Dictionary(uniqueKeysWithValues: aliveResults.map { ($0.id, (alive: $0.alive, pid: $0.pid)) })

        // Health check services that are alive and have a port
        let healthTargets = discovered.filter { svc in
            aliveMap[svc.id]?.alive == true && resolvePort(for: svc) != nil
        }
        let healths: [(String, Bool)] = await withTaskGroup(of: (String, Bool).self) { group in
            for svc in healthTargets {
                let label = svc.id
                let port = resolvePort(for: svc)!
                group.addTask { (label, await checkHealth(port: port)) }
            }
            var results: [(String, Bool)] = []
            for await result in group { results.append(result) }
            return results
        }
        let healthMap = Dictionary(uniqueKeysWithValues: healths)

        var updated: [BarryService] = []
        for var svc in discovered {
            let (alive, pid) = aliveMap[svc.id] ?? (false, nil)
            svc.pid = pid

            if !alive {
                svc.health = svc.isScheduled ? .scheduled : .stopped
            } else if resolvePort(for: svc) != nil {
                svc.health = (healthMap[svc.id] == true) ? .running : .unhealthy
            } else {
                svc.health = .running
            }

            updated.append(svc)
        }

        return updated
    }

    /// Check a single service's liveness + health.
    private func checkSingleService(_ service: BarryService) async -> ServiceHealth {
        let (alive, _) = isServiceAlive(service)
        if !alive { return .stopped }
        guard let port = resolvePort(for: service) else { return .running }
        return await checkHealth(port: port) ? .running : .unhealthy
    }

    /// Wait until a service reaches the expected state, or timeout.
    private func waitForState(
        service: BarryService,
        expect: ServiceHealth,
        maxAttempts: Int = 15,
        interval: UInt64 = 400_000_000  // 400ms
    ) async {
        for _ in 0..<maxAttempts {
            try? await Task.sleep(nanoseconds: interval)
            let current = await checkSingleService(service)
            if current == expect { break }
        }

        let snapshot = await fetchServiceState()
        await MainActor.run {
            _ = pendingActions.remove(service.id)
            self.services = snapshot
            self.lastRefresh = Date()
            self.clearAttentionFilterIfResolved()
        }
    }

    // MARK: - Actions

    func toggleService(_ service: BarryService) {
        if service.isRunning {
            if service.isSelf {
                confirmingAction = ConfirmAction(label: service.id, kind: .stop)
                return
            }
            performStop(service)
        } else {
            performStart(service)
        }
    }

    func requestRestart(_ service: BarryService) {
        if service.isSelf {
            confirmingAction = ConfirmAction(label: service.id, kind: .restart)
            return
        }
        performRestart(service)
    }

    func confirmAction() {
        guard let action = confirmingAction,
              let svc = services.first(where: { $0.id == action.label }) else {
            confirmingAction = nil
            return
        }
        confirmingAction = nil
        switch action.kind {
        case .stop: performStop(svc)
        case .restart: performRestart(svc)
        }
    }

    public func requestShutdown() {
        showShutdownConfirm = true
    }

    func confirmShutdown() {
        showShutdownConfirm = false
        isShuttingDown = true
        // Mark all running services as pending
        for svc in services where svc.isRunning {
            pendingActions.insert(svc.id)
        }
        Task {
            stopAllServices(services, includeSelf: true)
            // If we're still alive (self wasn't running), refresh
            let snapshot = await fetchServiceState()
            await MainActor.run {
                self.services = snapshot
                self.isShuttingDown = false
                self.pendingActions.removeAll()
                self.lastRefresh = Date()
            }
        }
    }

    private func performStart(_ service: BarryService) {
        pendingActions.insert(service.id)
        let svc = service
        let port = resolvePort(for: service)
        let expectHealth: ServiceHealth = .running
        Task {
            startService(svc)
            await waitForState(service: svc, expect: expectHealth,
                               maxAttempts: port != nil ? 15 : 5)
        }
    }

    private func performStop(_ service: BarryService) {
        pendingActions.insert(service.id)
        let svc = service
        Task {
            stopService(svc)
            await waitForState(service: svc, expect: .stopped, maxAttempts: 8)
        }
    }

    private func performRestart(_ service: BarryService) {
        pendingActions.insert(service.id)
        let svc = service
        let port = resolvePort(for: service)
        Task {
            restartService(svc)
            await waitForState(service: svc, expect: .running,
                               maxAttempts: port != nil ? 15 : 5)
        }
    }
}
