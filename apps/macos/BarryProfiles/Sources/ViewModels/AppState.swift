import SwiftUI

/// Top-level app state: profile list, connection status, polling.
@Observable
final class AppState: @unchecked Sendable {
    var profiles: [Profile] = []
    var isConnected = false
    var selectedProfileId: Int?
    var showingCreateProfile = false

    private let client = BarryClient()
    private var pollTimer: Timer?

    var selectedProfile: Profile? {
        profiles.first { $0.id == selectedProfileId }
    }

    // MARK: - Lifecycle

    func start() {
        Task { await checkConnection() }
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
            await refreshProfiles()
        }
    }

    // MARK: - Profiles

    func refreshProfiles() async {
        do {
            profiles = try await client.fetchProfiles()
        } catch {
            // Keep existing profiles on transient failure
        }
    }

    func createProfile(body: [String: Any]) async throws -> Profile {
        let profile = try await client.createProfile(body: body)
        await refreshProfiles()
        return profile
    }

    // MARK: - Polling

    private func startPolling() {
        pollTimer?.invalidate()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in
                await self.checkConnection()
            }
        }
    }
}
