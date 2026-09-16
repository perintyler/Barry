import Foundation

struct ResolvedToolsResponse: Codable {
    let traits: TraitsInfo
    let selectedNamespaces: [String]
    let selectedTools: [String]
    let namespaces: [NamespaceInfo]
    let tools: [ToolInfo]

    struct TraitsInfo: Codable {
        let active: [String]
        let available: [AvailableTrait]
    }

    struct AvailableTrait: Codable, Identifiable {
        let name: String
        let description: String?
        let access: String
        let namespaces: [String]

        var id: String { name }
    }

    struct NamespaceInfo: Codable, Identifiable {
        let name: String
        let enabled: Bool
        let grantedBy: [String]
        let toolCount: Int

        var id: String { name }
    }

    struct ToolInfo: Codable, Identifiable {
        let toolName: String
        let namespace: String
        let access: String
        let enabled: Bool
        let grantedBy: String?

        var id: String { toolName }
    }
}
