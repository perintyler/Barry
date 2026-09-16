import BarryKit
import BarrySessionsCore
import Combine
import SwiftUI

/// Top-level state for the identities window.
///
/// Unlike the popover surfaces this is a real window the user can leave open,
/// so it follows the `identities` bus topic rather than the 15s timer the
/// standalone app polled on. The server already publishes that topic on every
/// create and update.
@MainActor
public final class IdentitiesState: ObservableObject {
    @Published public private(set) var identities: [Identity] = []
    @Published public private(set) var isConnected = false
    @Published public private(set) var loadError: String?
    @Published public var selectedId: Int?
    @Published public var searchText = ""

    private let client = IdentityClient()
    private let bus: BusClient?
    private let ownsBus: Bool

    /// - Parameter bus: an app-wide socket to share, when there is one.
    ///
    /// Passing nil builds a private client and starts it — which is what the
    /// standalone Barry Identities app needs, since it has no shell to inherit
    /// a socket from. When the window lived inside Barry Sessions this was
    /// always injected, and `ownsBus` was hardcoded false; left that way the
    /// standalone app would subscribe to a socket nothing ever connected and
    /// silently never update.
    public init(bus: BusClient? = nil) {
        if let bus {
            self.bus = bus
            self.ownsBus = false
        } else {
            let core = BarryCore()
            self.bus = BusClient(
                baseURL: core.baseURL,
                secret: core.authToken,
                topics: ["identities"]
            )
            self.ownsBus = true
        }
    }

    public var visibleIdentities: [Identity] {
        guard !searchText.isEmpty else { return identities }
        let needle = searchText.lowercased()
        return identities.filter {
            $0.name.lowercased().contains(needle) ||
            ($0.displayName?.lowercased().contains(needle) ?? false)
        }
    }

    public var selected: Identity? {
        identities.first { $0.id == selectedId }
    }

    public func start() {
        Task { await refresh() }
        bus?.subscribe("identities") { [weak self] _ in
            Task { @MainActor in await self?.refresh() }
        }
        if ownsBus { bus?.start() }
    }

    public func refresh() async {
        do {
            let fetched = try await client.fetchIdentities()
            identities = fetched
            isConnected = true
            loadError = nil
            // Keep a selection pointing at something real: an identity can be
            // deleted from the CLI while this window is open.
            if let selectedId, !fetched.contains(where: { $0.id == selectedId }) {
                self.selectedId = fetched.first?.id
            }
            if selectedId == nil { selectedId = fetched.first?.id }
        } catch {
            isConnected = false
            loadError = error.localizedDescription
        }
    }

    /// Delete a DB-backed identity. Returns an error message on refusal —
    /// notably for file-based identities, which the API declines because they
    /// are directories the user owns.
    public func delete(id: Int) async -> String? {
        do {
            try await client.deleteIdentity(id: id)
            await refresh()
            return nil
        } catch {
            return error.localizedDescription
        }
    }
}
