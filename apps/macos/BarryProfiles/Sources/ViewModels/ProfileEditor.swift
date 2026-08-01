import SwiftUI
import BarryKit

/// Manages the editing state for a single profile's configuration.
@Observable
final class ProfileEditor: @unchecked Sendable {
    let profile: Profile

    // Server-loaded data
    var allTraits: [TraitInfo] = []
    var allScopes: [ScopeRecord] = []
    var allPacks: [PackInfo] = []
    var modelCatalog: [String: ProviderModels] = [:]

    // Editable selections
    var selectedPacks: Set<String> = []
    var selectedTraits: Set<String> = []
    var selectedScopeId: Int?
    var selectedAgent: String?
    var selectedModel: String?

    // Server state (for pending changes detection)
    private var serverPacks: Set<String> = []
    private var serverTraits: Set<String> = []
    private var serverScopeId: Int?

    // UI
    var tab: Tab = .info
    var filterText = ""
    var isLoading = false
    var errorMessage: String?

    private let client = BarryClient()

    enum Tab: String, CaseIterable {
        case info = "Info"
        case packs = "Packs"
        case traits = "Traits"
        case scopes = "Scopes"
    }

    init(profile: Profile) {
        self.profile = profile
        self.selectedPacks = Set(profile.packs)
        self.serverPacks = Set(profile.packs)
        self.selectedTraits = Set(profile.traits)
        self.serverTraits = Set(profile.traits)
        self.selectedScopeId = profile.scopeId
        self.serverScopeId = profile.scopeId
        self.selectedAgent = profile.defaultCodingAgent
        self.selectedModel = profile.defaultModel
    }

    // MARK: - Loading

    func load() async {
        isLoading = true
        errorMessage = nil
        do {
            async let t = client.fetchTraits()
            async let s = client.fetchScopes()
            async let p = client.fetchAvailablePacks()
            allTraits = try await t
            allScopes = try await s
            allPacks = try await p
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

    var filteredPacks: [PackInfo] {
        guard !filterText.isEmpty else { return allPacks }
        let lf = filterText.lowercased()
        return allPacks.filter {
            $0.name.lowercased().contains(lf) ||
            ($0.description?.lowercased().contains(lf) ?? false)
        }
    }

    var enabledPacks: [PackInfo] {
        filteredPacks.filter { selectedPacks.contains($0.name) }
    }

    var availablePacks: [PackInfo] {
        filteredPacks.filter { !selectedPacks.contains($0.name) }
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

    func togglePack(_ name: String) {
        if selectedPacks.contains(name) {
            selectedPacks.remove(name)
        } else {
            selectedPacks.insert(name)
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

    // MARK: - Pending Changes (packs + traits only — scope & agent/model save immediately)

    var pendingChangeCount: Int {
        symmetricDiffCount(selectedPacks, serverPacks) +
        symmetricDiffCount(selectedTraits, serverTraits)
    }

    var hasPendingChanges: Bool { pendingChangeCount > 0 }

    func resetPending() {
        selectedPacks = serverPacks
        selectedTraits = serverTraits
    }

    func applyPending() async {
        do {
            var body: [String: Any] = [:]
            if selectedPacks != serverPacks {
                body["packs"] = Array(selectedPacks).sorted()
            }
            if selectedTraits != serverTraits {
                body["traits"] = Array(selectedTraits).sorted()
            }
            if !body.isEmpty {
                try await client.updateProfile(id: profile.id, body: body)
                serverPacks = selectedPacks
                serverTraits = selectedTraits
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Immediate Saves

    func saveAgent(_ agent: String?) async {
        selectedAgent = agent
        do {
            try await client.updateProfile(id: profile.id, body: [
                "defaultCodingAgent": agent as Any
            ])
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func saveModel(_ model: String?) async {
        selectedModel = model
        do {
            try await client.updateProfile(id: profile.id, body: [
                "defaultModel": model as Any
            ])
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func saveScope() async {
        do {
            try await client.updateProfile(id: profile.id, body: [
                "scopeId": selectedScopeId as Any
            ])
            serverScopeId = selectedScopeId
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func setAsDefault() async {
        do {
            try await client.setDefaultProfile(id: profile.id)
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
