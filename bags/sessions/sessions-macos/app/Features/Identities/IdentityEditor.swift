import SwiftUI
import BarryKit

/// Manages the editing state for a single Identity's configuration.
@Observable
public final class IdentityEditor: @unchecked Sendable {
    /// The identity as the server last described it.
    ///
    /// `var`, not `let`. It used to be captured once at init, so every field
    /// the panels read straight off it — token, created, env keys, isDefault —
    /// kept showing pre-save values until the user navigated away and back.
    /// Saves now refresh it.
    public private(set) var identity: Identity

    // Server-loaded data
    var allTraits: [TraitInfo] = []
    var allScopes: [ScopeRecord] = []
    var allBags: [BagInfo] = []
    var modelCatalog: [String: ProviderModels] = [:]

    // Editable selections
    var selectedBags: Set<String> = []
    var selectedTraits: Set<String> = []
    var selectedScopeId: Int?
    var selectedAgent: String?
    var selectedModel: String?

    // Server state (for pending changes detection)
    private var serverBags: Set<String> = []
    private var serverTraits: Set<String> = []
    private var serverScopeId: Int?

    // UI
    var tab: Tab = .info
    var isLoading = false
    var errorMessage: String?
    /// Non-fatal warnings from the last save. The API accepts values it can't
    /// vouch for rather than rejecting them, so this is the only signal that a
    /// setting landed but may not do what the user expects.
    ///
    /// Plural: the server returns one per bag, and keeping only the first hid
    /// every warning after it — most importantly the `launchd-required` ones
    /// that tell the user a bag needs `barry pack` before it does anything.
    var warnings: [String] = []
    /// Which tab a warning or error belongs to, so it can be shown where the
    /// change was made instead of only on Info.
    var messageTab: Tab?

    /// Per-tab filter text. One shared string meant typing a filter on Bags
    /// left Traits filtered when you switched, with no visible cause.
    private var filters: [Tab: String] = [:]

    func filterText(for tab: Tab) -> String { filters[tab] ?? "" }

    func setFilterText(_ text: String, for tab: Tab) { filters[tab] = text }

    private let client = IdentityClient()

    /// File-based Identities have no scope — the API rejects scope writes against
    /// them, so the Scopes tab explains that instead of offering a picker.
    var isFileBased: Bool { identity.isFileBased }

    enum Tab: String, CaseIterable {
        case info = "Info"
        case bags = "Bags"
        case traits = "Traits"
        case scopes = "Scopes"
    }

    init(identity: Identity) {
        self.identity = identity
        self.selectedBags = Set(identity.bags)
        self.serverBags = Set(identity.bags)
        self.selectedTraits = Set(identity.traits)
        self.serverTraits = Set(identity.traits)
        self.selectedScopeId = identity.scopeId
        self.serverScopeId = identity.scopeId
        self.selectedAgent = identity.defaultCodingAgent
        self.selectedModel = identity.defaultModel
    }

    // MARK: - Loading

    func load() async {
        isLoading = true
        errorMessage = nil
        warnings = []
        messageTab = nil
        do {
            async let t = client.fetchTraits()
            async let s = client.fetchScopes()
            async let p = client.fetchAvailableBags()
            allTraits = try await t
            allScopes = try await s
            allBags = try await p
        } catch {
            errorMessage = error.localizedDescription
        }
        // Model catalog is advisory — load best-effort, never surface an error
        if let catalog = try? await client.fetchModels() {
            modelCatalog = catalog
        }
        isLoading = false
    }

    // MARK: - Filtering

    var filteredBags: [BagInfo] {
        let filter = filterText(for: .bags)
        guard !filter.isEmpty else { return allBags }
        let lf = filter.lowercased()
        return allBags.filter {
            $0.name.lowercased().contains(lf) ||
            ($0.description?.lowercased().contains(lf) ?? false)
        }
    }

    /// Enabled bags are listed in full, regardless of the filter.
    ///
    /// Filtering this list too meant a pending *removal* could be filtered out
    /// of sight while still counting toward `pendingChangeCount` — the bar
    /// offered to apply N changes with fewer than N visible.
    var enabledBags: [BagInfo] {
        allBags.filter { selectedBags.contains($0.name) }
    }

    var availableBags: [BagInfo] {
        filteredBags.filter { !selectedBags.contains($0.name) }
    }

    var filteredTraits: [TraitInfo] {
        let filter = filterText(for: .traits)
        guard !filter.isEmpty else { return allTraits }
        let lf = filter.lowercased()
        return allTraits.filter {
            $0.name.lowercased().contains(lf) ||
            ($0.description?.lowercased().contains(lf) ?? false)
        }
    }

    // MARK: - Toggles

    func toggleBag(_ name: String) {
        if selectedBags.contains(name) {
            selectedBags.remove(name)
        } else {
            selectedBags.insert(name)
        }
    }

    func toggleTrait(_ name: String) {
        if selectedTraits.contains(name) {
            selectedTraits.remove(name)
        } else {
            selectedTraits.insert(name)
        }
    }

    func selectScope(_ id: Int?) {
        selectedScopeId = id
        // Scope changes save immediately
        Task { await saveScope() }
    }

    // MARK: - Pending Changes (bags + traits only — scope & agent/model save immediately)

    var pendingChangeCount: Int {
        symmetricDiffCount(selectedBags, serverBags) +
        symmetricDiffCount(selectedTraits, serverTraits)
    }

    var hasPendingChanges: Bool { pendingChangeCount > 0 }

    func resetPending() {
        selectedBags = serverBags
        selectedTraits = serverTraits
    }

    func applyPending() async {
        do {
            var body: [String: Any] = [:]
            if selectedBags != serverBags {
                body["bags"] = Array(selectedBags).sorted()
            }
            if selectedTraits != serverTraits {
                body["traits"] = Array(selectedTraits).sorted()
            }
            if !body.isEmpty {
                let warnings = try await client.updateIdentity(id: identity.id, body: body)
                applySaveResult(warnings)
                serverBags = selectedBags
                serverTraits = selectedTraits
                await refreshIdentity()
            }
        } catch {
            reportSaveFailure(error)
        }
    }

    // Both banners describe the most recent save, so every save has to settle
    // both — otherwise a warning outlives the value that caused it, or a stale
    // error sits next to a save that just succeeded.
    private func applySaveResult(_ warnings: [String], from tab: Tab? = nil) {
        errorMessage = nil
        // Every warning, not just the first. The server emits one per bag, and
        // the launchd-required ones are exactly the warnings a user needs.
        self.warnings = warnings
        messageTab = warnings.isEmpty ? nil : (tab ?? self.tab)
    }

    private func reportSaveFailure(_ error: any Error, from tab: Tab? = nil) {
        errorMessage = error.localizedDescription
        warnings = []
        messageTab = tab ?? self.tab
    }

    /// Re-read this identity from the server after a write.
    ///
    /// The panels render fields straight off `identity` — token, created,
    /// env keys, whether it is active — so without this a save leaves the
    /// detail pane describing the pre-save state until the user navigates
    /// away and back.
    private func refreshIdentity() async {
        guard let fresh = try? await client.fetchIdentity(id: identity.id) else { return }
        identity = fresh
    }

    // MARK: - Immediate Saves

    func saveAgent(_ agent: String?) async {
        selectedAgent = agent
        do {
            applySaveResult(try await client.updateIdentity(id: identity.id, body: [
                "defaultCodingAgent": agent as Any
            ]))
            await refreshIdentity()
        } catch {
            reportSaveFailure(error)
        }
    }

    func saveModel(_ model: String?) async {
        selectedModel = model
        do {
            applySaveResult(try await client.updateIdentity(id: identity.id, body: [
                "defaultModel": model as Any
            ]))
            await refreshIdentity()
        } catch {
            reportSaveFailure(error)
        }
    }

    private func saveScope() async {
        do {
            applySaveResult(try await client.updateIdentity(id: identity.id, body: [
                "scopeId": selectedScopeId as Any
            ]))
            serverScopeId = selectedScopeId
        } catch {
            reportSaveFailure(error)
        }
    }

    func setAsActive() async {
        do {
            try await client.setActiveIdentity(id: identity.id)
            // Without this the button keeps offering "Set as Active" for the
            // identity that just became active — `isDefault` is read off the
            // record, which the call above only changed server-side.
            await refreshIdentity()
        } catch {
            reportSaveFailure(error, from: .info)
        }
    }

    // MARK: - Notifier / native tools

    func saveNotifier(tool: String?, target: String?) async {
        do {
            let value: Any = tool.map { t -> [String: Any] in
                var payload: [String: Any] = ["tool": t]
                if let target, !target.isEmpty { payload["target"] = target }
                return payload
            } ?? NSNull()
            applySaveResult(
                try await client.updateIdentity(id: identity.id, body: ["statusNotify": value]),
                from: .info
            )
            await refreshIdentity()
        } catch {
            reportSaveFailure(error, from: .info)
        }
    }

    func saveAllowNativeTools(_ allow: Bool) async {
        do {
            applySaveResult(
                try await client.updateIdentity(id: identity.id, body: ["allowNativeTools": allow]),
                from: .info
            )
            await refreshIdentity()
        } catch {
            reportSaveFailure(error, from: .info)
        }
    }

    // MARK: - Trait authoring

    /// Every namespace any installed trait exposes.
    ///
    /// The namespace list isn't an endpoint of its own, but a trait grants
    /// namespaces and the trait list carries them — so the union across
    /// installed traits is exactly the set a new trait can draw from. Anything
    /// outside it would name a namespace no bag provides, and resolve to no
    /// tools.
    var availableNamespaces: [String] {
        Set(allTraits.flatMap { $0.namespaces ?? [] }).sorted()
    }

    /// Create a hand-authored trait and refresh the list so it is immediately
    /// selectable.
    func createTrait(
        name: String,
        description: String?,
        namespaces: [String],
        access: String,
        scopeNames: [String]
    ) async -> Bool {
        do {
            var body: [String: Any] = [
                "name": name,
                "namespaces": namespaces,
                "access": access
            ]
            if let description, !description.isEmpty { body["description"] = description }
            if !scopeNames.isEmpty { body["scopeNames"] = scopeNames }
            try await client.createTrait(body: body)
            allTraits = (try? await client.fetchTraits()) ?? allTraits
            applySaveResult([], from: .traits)
            return true
        } catch {
            reportSaveFailure(error, from: .traits)
            return false
        }
    }

    /// Edit an existing scope's description and deny rules.
    ///
    /// - Parameter network: the network rules to store. The PATCH replaces the
    ///   whole `scope` object, so this is the value that survives — passing nil
    ///   deletes any rules the scope had.
    func updateScope(
        id: Int,
        description: String?,
        deniedTools: [String],
        deniedAccess: [String],
        fileDeny: [String],
        bashDeny: [String],
        network: ScopeRecord.AgentScope.NetworkRules?
    ) async -> Bool {
        do {
            let scope = ScopeRecord.AgentScope(
                deniedTools: deniedTools.isEmpty ? nil : deniedTools,
                deniedAccess: deniedAccess.isEmpty ? nil : deniedAccess,
                files: fileDeny.isEmpty ? nil : .init(deny: fileDeny),
                bash: bashDeny.isEmpty ? nil : .init(deny: bashDeny),
                network: network
            )
            let encoded = try JSONEncoder().encode(scope)
            let asObject = try JSONSerialization.jsonObject(with: encoded)
            var body: [String: Any] = ["scope": asObject]
            body["description"] = description ?? NSNull()
            try await client.updateScope(id: id, body: body)
            allScopes = (try? await client.fetchScopes()) ?? allScopes
            applySaveResult([], from: .scopes)
            return true
        } catch {
            reportSaveFailure(error, from: .scopes)
            return false
        }
    }

    // MARK: - Scope Creation

    func createScope(
        name: String,
        description: String?,
        deniedTools: [String],
        deniedAccess: [String],
        fileDeny: [String],
        bashDeny: [String],
        network: ScopeRecord.AgentScope.NetworkRules? = nil
    ) async -> ScopeRecord? {
        do {
            let scope = ScopeRecord.AgentScope(
                deniedTools: deniedTools.isEmpty ? nil : deniedTools,
                deniedAccess: deniedAccess.isEmpty ? nil : deniedAccess,
                files: fileDeny.isEmpty ? nil : .init(deny: fileDeny),
                bash: bashDeny.isEmpty ? nil : .init(deny: bashDeny),
                network: network
            )
            let created = try await client.createScope(name: name, description: description, scope: scope)
            allScopes.append(created)
            return created
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    // MARK: - Helpers

    func scopeName(for id: Int?) -> String? {
        guard let id else { return nil }
        return allScopes.first { $0.id == id }?.name
    }

    private func symmetricDiffCount(_ a: Set<String>, _ b: Set<String>) -> Int {
        a.subtracting(b).count + b.subtracting(a).count
    }
}
