import Foundation

/// The defaults slice of a profile (`GET /profiles`) — enough to resolve
/// what model/provider a session inherits. BarryProfiles keeps its own
/// richer `Profile` model; this is for apps that only need the defaults.
public struct ProfileDefaults: Decodable, Identifiable {
    public let id: Int
    public let name: String
    public let defaultModel: String?
    public let defaultCodingAgent: String?

}

public extension BarryCore {
    /// Per-profile default provider/model (`GET /profiles`).
    func fetchProfileDefaults() async throws -> [ProfileDefaults] {
        let response = try await transport.listProfiles()
        return try JSONDecoder().decode(
            [ProfileDefaults].self,
            from: JSONEncoder().encode(response.profiles)
        )
    }
}
