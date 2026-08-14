import SwiftUI

/// Top-level app state: identity list, connection status, polling.
@Observable
final class AppState: @unchecked Sendable {
    var identities: [Identity] = []
    var isConnected = false
    var selectedIdentityId: Int?
    var showingCreateIdentity = false
    /// Set when a refresh fails so the list can say why it's empty. A silent
    /// catch here once hid a decode error behind an empty list for hours.
    var loadError: String?

    private let client = IdentityClient()
    private var pollTimer: Timer?

    var selectedIdentity: Identity? {
        identities.first { $0.id == selectedIdentityId }
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
            await refreshIdentities()
        }
    }

    // MARK: - Identities

    func refreshIdentities() async {
        do {
            identities = try await client.fetchIdentities()
            loadError = nil
        } catch {
            // Keep whatever we already had — a dropped poll shouldn't blank the
            // list — but surface the reason, or a decode failure looks like
            // "you have no identities".
            loadError = "\(error)"
        }
    }

    func createIdentity(body: [String: Any]) async throws -> Identity {
        let identity = try await client.createIdentity(body: body)
        await refreshIdentities()
        return identity
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
