import SwiftUI

/// Manages the editing state for a single session's capabilities.
/// Tracks pending changes across traits, namespaces, and tools — mirrors the `barry start` picker.
/// All three are additive: traits grant namespaces, but you can also directly select namespaces or tools.
@Observable
final class SessionEditor: @unchecked Sendable {
    let session: Session

    // Available data from server
    var availableTraits: [ResolvedToolsResponse.AvailableTrait] = []
    var allNamespaces: [ResolvedToolsResponse.NamespaceInfo] = []
    var allTools: [ResolvedToolsResponse.ToolInfo] = []

    // Current selections (all three are independent, additive)
    var selectedTraits: Set<String> = []
    var selectedNamespaces: Set<String> = []
    var selectedTools: Set<String> = []

    // Server state
    private var serverTraits: Set<String> = []
    private var serverNamespaces: Set<String> = []
    private var serverTools: Set<String> = []

    // UI state
    var topTab: TopTab = .messages
    var toolingTab: ToolingTab = .traits
    var filterText = ""
    var isLoading = false
    var errorMessage: String?

    private let client = BarryClient()

    /// Top-level navigation: Messages | Tooling | Info
    enum TopTab: String, CaseIterable {
        case messages = "Messages"
        case tooling = "Tooling"
        case info = "Info"
    }

    /// Sub-tabs within Tooling
    enum ToolingTab: String, CaseIterable {
        case traits = "Traits"
        case namespaces = "Namespaces"
        case tools = "Tools"
    }

    init(session: Session) {
        self.session = session
        self.selectedTraits = Set(session.traits)
        self.serverTraits = Set(session.traits)
    }

    // MARK: - Data Loading

    func load() async {
        isLoading = true
        errorMessage = nil
        do {
            let resolved = try await client.fetchResolvedTools(sessionId: session.id)
            availableTraits = resolved.traits.available
            allNamespaces = resolved.namespaces
            allTools = resolved.tools

            selectedTraits = Set(resolved.traits.active)
            selectedNamespaces = Set(resolved.selectedNamespaces)
            selectedTools = Set(resolved.selectedTools)

            serverTraits = selectedTraits
            serverNamespaces = selectedNamespaces
            serverTools = selectedTools
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    // MARK: - Resolution (what's effectively enabled)

    /// Namespaces enabled by traits (not including direct namespace picks)
    var traitGrantedNamespaces: Set<String> {
        var ns = Set<String>()
        for traitName in selectedTraits {
            if let trait = availableTraits.first(where: { $0.name == traitName }) {
                ns.formUnion(trait.namespaces)
            }
        }
        return ns
    }

    /// All enabled namespaces (trait-granted + directly selected)
    var enabledNamespaces: Set<String> {
        traitGrantedNamespaces.union(selectedNamespaces)
    }

    /// All enabled tools (from enabled namespaces + directly selected tools)
    var enabledTools: Set<String> {
        let ns = enabledNamespaces
        var tools = Set<String>()
        for tool in allTools where ns.contains(tool.namespace) {
            tools.insert(tool.toolName)
        }
        tools.formUnion(selectedTools)
        return tools
    }

    /// Traits that grant a given namespace
    func grantingTraits(for namespace: String) -> [String] {
        selectedTraits.compactMap { traitName in
            let trait = availableTraits.first { $0.name == traitName }
            return trait?.namespaces.contains(namespace) == true ? traitName : nil
        }.sorted()
    }

    // MARK: - Filtering

    var filteredTraits: [ResolvedToolsResponse.AvailableTrait] {
        guard !filterText.isEmpty else { return availableTraits }
        let lf = filterText.lowercased()
        return availableTraits.filter {
            $0.name.lowercased().contains(lf) ||
            ($0.description?.lowercased().contains(lf) ?? false)
        }
    }

    var filteredNamespaces: [ResolvedToolsResponse.NamespaceInfo] {
        guard !filterText.isEmpty else { return allNamespaces }
        let lf = filterText.lowercased()
        return allNamespaces.filter { $0.name.lowercased().contains(lf) }
    }

    var filteredTools: [ResolvedToolsResponse.ToolInfo] {
        guard !filterText.isEmpty else { return allTools }
        let lf = filterText.lowercased()
        return allTools.filter {
            $0.toolName.lowercased().contains(lf) ||
            $0.namespace.lowercased().contains(lf)
        }
    }

    // MARK: - Selection

    func toggleTrait(_ name: String) {
        if selectedTraits.contains(name) {
            selectedTraits.remove(name)
        } else {
            selectedTraits.insert(name)
        }
    }

    func toggleNamespace(_ name: String) {
        if selectedNamespaces.contains(name) {
            selectedNamespaces.remove(name)
        } else {
            selectedNamespaces.insert(name)
        }
    }

    func toggleTool(_ name: String) {
        if selectedTools.contains(name) {
            selectedTools.remove(name)
        } else {
            selectedTools.insert(name)
        }
    }

    // MARK: - Pending State

    var pendingChangeCount: Int {
        symmetricDiffCount(selectedTraits, serverTraits) +
        symmetricDiffCount(selectedNamespaces, serverNamespaces) +
        symmetricDiffCount(selectedTools, serverTools)
    }

    var hasPendingChanges: Bool { pendingChangeCount > 0 }

    func reset() {
        selectedTraits = serverTraits
        selectedNamespaces = serverNamespaces
        selectedTools = serverTools
    }

    func apply() async {
        do {
            try await client.updateSession(
                sessionId: session.id,
                traits: Array(selectedTraits).sorted(),
                selectedNamespaces: Array(selectedNamespaces).sorted(),
                selectedTools: Array(selectedTools).sorted()
            )
            serverTraits = selectedTraits
            serverNamespaces = selectedNamespaces
            serverTools = selectedTools
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func symmetricDiffCount(_ a: Set<String>, _ b: Set<String>) -> Int {
        a.subtracting(b).count + b.subtracting(a).count
    }
}
