import Foundation

struct Profile: Codable, Identifiable {
    let id: Int
    let name: String
    let token: String
    let parentId: Int?
    let parentName: String?
    let blocks: [String]
    let traits: [String]
    let scopeId: Int?
    let defaultCodingAgent: String?
    let defaultModel: String?
    let envKeys: [String]
    let vaultEmail: String?
    let isDefault: Bool
    let lastUsedAt: String?
    let createdAt: String?

    var displayLastUsed: String {
        guard let raw = lastUsedAt else { return "never used" }
        return formatRelativeTime(raw) ?? raw
    }
}

struct ProfilesResponse: Codable {
    let profiles: [Profile]
}
