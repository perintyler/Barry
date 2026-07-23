import SwiftUI
import Combine
import BarryKit

/// Top-level app state: session list, connection status, polling.
@Observable
final class AppState: @unchecked Sendable {
    var activeSessions: [Session] = []
    var recentSessions: [Session] = []
    var isConnected = false
    var selectedSessionId: String?
    var hasMoreRecent = true
    private var recentCursor: String?
    var isLoadingMore = false
    var profiles: [ProfileDefaults] = []
    var availableTraits: [TraitInfo] = []

    private let client = BarryClient()
    private var pollTimer: Timer?
    private let recentPageSize = 20

    /// All sessions: deduplicated and sorted by last message time (most recent first).
    /// Active sessions are merged with recent to avoid duplicates.
    var sessions: [Session] {
        let activeIds = Set(activeSessions.map(\.id))
        let dedupedRecent = recentSessions.filter { !activeIds.contains($0.id) }
        let all = activeSessions + dedupedRecent
        return all.sorted { a, b in
            let aTime = a.lastMessageAt ?? a.createdAt ?? ""
            let bTime = b.lastMessageAt ?? b.createdAt ?? ""
            return aTime > bTime
        }
    }

    var selectedSession: Session? {
        sessions.first { $0.id == selectedSessionId }
    }

    // MARK: - Lifecycle

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
        startPolling()
    }

    func stop() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    // MARK: - Connection

    func checkConnection() async {
        isConnected = await client.checkHealth()
        if isConnected {
            await refreshSessions()
        }
    }

    // MARK: - Sessions

    func refreshSessions() async {
        do {
            activeSessions = try await client.fetchActiveSessions()
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
        await loadMoreRecent()
    }

    func loadMoreRecent() async {
        guard hasMoreRecent, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }

        do {
            let response = try await client.fetchRecentSessions(
                limit: recentPageSize,
                cursor: recentCursor
            )
            recentSessions.append(contentsOf: response.sessions)
            recentCursor = response.nextCursor
            hasMoreRecent = response.nextCursor != nil
        } catch {
            // Keep existing on failure
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

    func loadSessionCreationOptions() async {
        async let loadedProfiles = try? client.fetchProfileDefaults()
        async let loadedTraits = try? client.fetchTraits()
        profiles = await loadedProfiles ?? []
        availableTraits = await loadedTraits ?? []
    }

    func createSession(
        prompt: String,
        repoPath: String,
        name: String?,
        profileId: Int?,
        traits: [String],
        provider: String,
        model: String?,
        useWorktree: Bool
    ) async throws {
        let session = try await client.createSession(
            prompt: prompt,
            repoPath: repoPath,
            name: name,
            profileId: profileId,
            traits: traits,
            provider: provider,
            model: model,
            useWorktree: useWorktree
        )
        await refreshSessionList()
        selectedSessionId = session.id
    }

    // MARK: - Polling

    private func startPolling() {
        pollTimer?.invalidate()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in
                await self.checkConnection()
            }
        }
    }
}
