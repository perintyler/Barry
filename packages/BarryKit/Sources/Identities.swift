import Foundation

/// The defaults slice of a profile (`GET /profiles`) — enough to resolve
/// what model/provider a session inherits. My Identities keeps its own
/// richer `Profile` model; this is for apps that only need the defaults.
public struct IdentityDefaults: Decodable, Identifiable {
    public let id: Int
    public let name: String
    public let defaultModel: String?
    public let defaultCodingAgent: String?

}

public extension BarryCore {
    /// Per-profile default provider/model (`GET /profiles`).
    func fetchIdentityDefaults() async throws -> [IdentityDefaults] {
        let response = try await transport.listIdentities()
        return try JSONDecoder().decode(
            [IdentityDefaults].self,
            from: JSONEncoder().encode(response.identities)
        )
    }
}
