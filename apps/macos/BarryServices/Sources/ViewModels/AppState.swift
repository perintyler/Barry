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
final class AppState: @unchecked Sendable {
    var services: [BarryService] = []
    var isLoading = true
    var lastRefresh: Date?
    var pendingActions: Set<String> = []
    var confirmingAction: ConfirmAction?
    var isShuttingDown = false
    var showShutdownConfirm = false

    private var pollTimer: Timer?

    // MARK: - Computed

    var grouped: [(ServiceCategory, [BarryService])] {
        let dict = Dictionary(grouping: services, by: \.category)
        return ServiceCategory.allCases.compactMap { cat in
            guard let svcs = dict[cat], !svcs.isEmpty else { return nil }
            return (cat, svcs)
        }
    }

    var runningCount: Int { services.filter { $0.isRunning }.count }

    // MARK: - Lifecycle

    func start() {
        refresh()
        startPolling()
    }

    func stop() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    // MARK: - Polling

    private func startPolling() {
        pollTimer?.invalidate()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    // MARK: - Refresh

    func refresh() {
        Task {
            let snapshot = await fetchServiceState()
            await MainActor.run {
                self.services = snapshot
                self.isLoading = false
                self.lastRefresh = Date()
            }
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

    func requestShutdown() {
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
