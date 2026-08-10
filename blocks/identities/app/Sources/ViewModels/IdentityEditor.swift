import SwiftUI
import BarryKit

/// Manages the editing state for a single Identity's configuration.
@Observable
final class IdentityEditor: @unchecked Sendable {
    let identity: Identity

    // Server-loaded data
    var allTraits: [TraitInfo] = []
    var allScopes: [ScopeRecord] = []
    var allBlocks: [BlockInfo] = []
    var modelCatalog: [String: ProviderModels] = [:]

    // Editable selections
    var selectedBlocks: Set<String> = []
    var selectedTraits: Set<String> = []
    var selectedScopeId: Int?
    var selectedAgent: String?
    var selectedModel: String?

    // Server state (for pending changes detection)
    private var serverBlocks: Set<String> = []
    private var serverTraits: Set<String> = []
    private var serverScopeId: Int?

    // UI
    var tab: Tab = .info
    var filterText = ""
    var isLoading = false
    var errorMessage: String?
    /// Non-fatal warnings from the last save. The API accepts values it can't
    /// vouch for rather than rejecting them, so this is the only signal that a
    /// setting landed but may not do what the user expects.
    var warningMessage: String?

    private let client = IdentityClient()

    /// File-based Identities have no scope — the API rejects scope writes against
    /// them, so the Scopes tab explains that instead of offering a picker.
    var isFileBased: Bool { identity.isFileBased }

    enum Tab: String, CaseIterable {
        case info = "Info"
        case blocks = "Blocks"
        case traits = "Traits"
        case scopes = "Scopes"
    }

    init(identity: Identity) {
        self.identity = identity
        self.selectedBlocks = Set(identity.blocks)
        self.serverBlocks = Set(identity.blocks)
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
        warningMessage = nil
        do {
            async let t = client.fetchTraits()
            async let s = client.fetchScopes()
            async let p = client.fetchAvailableBlocks()
            allTraits = try await t
            allScopes = try await s
            allBlocks = try await p
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

    var filteredBlocks: [BlockInfo] {
        guard !filterText.isEmpty else { return allBlocks }
        let lf = filterText.lowercased()
        return allBlocks.filter {
            $0.name.lowercased().contains(lf) ||
            ($0.description?.lowercased().contains(lf) ?? false)
        }
    }

    var enabledBlocks: [BlockInfo] {
        filteredBlocks.filter { selectedBlocks.contains($0.name) }
    }

    var availableBlocks: [BlockInfo] {
        filteredBlocks.filter { !selectedBlocks.contains($0.name) }
    }

    var filteredTraits: [TraitInfo] {
        guard !filterText.isEmpty else { return allTraits }
        let lf = filterText.lowercased()
        return allTraits.filter {
            $0.name.lowercased().contains(lf) ||
            ($0.description?.lowercased().contains(lf) ?? false)
        }
    }

    // MARK: - Toggles

    func toggleBlock(_ name: String) {
        if selectedBlocks.contains(name) {
            selectedBlocks.remove(name)
        } else {
            selectedBlocks.insert(name)
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

    // MARK: - Pending Changes (blocks + traits only — scope & agent/model save immediately)

    var pendingChangeCount: Int {
        symmetricDiffCount(selectedBlocks, serverBlocks) +
        symmetricDiffCount(selectedTraits, serverTraits)
    }

    var hasPendingChanges: Bool { pendingChangeCount > 0 }

    func resetPending() {
        selectedBlocks = serverBlocks
        selectedTraits = serverTraits
    }

    func applyPending() async {
        do {
            var body: [String: Any] = [:]
            if selectedBlocks != serverBlocks {
                body["blocks"] = Array(selectedBlocks).sorted()
            }
            if selectedTraits != serverTraits {
                body["traits"] = Array(selectedTraits).sorted()
            }
            if !body.isEmpty {
                let warnings = try await client.updateIdentity(id: identity.id, body: body)
                applySaveResult(warnings)
                serverBlocks = selectedBlocks
                serverTraits = selectedTraits
            }
        } catch {
            reportSaveFailure(error)
        }
    }

    // Both banners describe the most recent save, so every save has to settle
    // both — otherwise a warning outlives the value that caused it, or a stale
    // error sits next to a save that just succeeded.
    private func applySaveResult(_ warnings: [String]) {
        errorMessage = nil
        warningMessage = warnings.first
    }

    private func reportSaveFailure(_ error: any Error) {
        errorMessage = error.localizedDescription
        warningMessage = nil
    }

    // MARK: - Immediate Saves

    func saveAgent(_ agent: String?) async {
        selectedAgent = agent
        do {
            applySaveResult(try await client.updateIdentity(id: identity.id, body: [
                "defaultCodingAgent": agent as Any
            ]))
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
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Scope Creation

    func createScope(
        name: String,
        description: String?,
        deniedTools: [String],
        deniedAccess: [String],
        fileDeny: [String],
        bashDeny: [String]
    ) async -> ScopeRecord? {
        do {
            let scope = ScopeRecord.AgentScope(
                deniedTools: deniedTools.isEmpty ? nil : deniedTools,
                deniedAccess: deniedAccess.isEmpty ? nil : deniedAccess,
                files: fileDeny.isEmpty ? nil : .init(deny: fileDeny),
                bash: bashDeny.isEmpty ? nil : .init(deny: bashDeny)
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
